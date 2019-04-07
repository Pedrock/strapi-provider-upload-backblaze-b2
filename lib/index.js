'use strict';
const B2 = require('backblaze-b2');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callWithBackOff(request) {
    const maxDelay = 16000;
    let delay = 1000;
    while (true) {
        try {
            const { data } = await request();
            return data;
        } catch (error) {
            if (!error.response) {
                throw error;
            }
            const { response } = error;
            const status = response.status;
            if (status == 429 /*Too Many Requests*/) {
                const sleep = response.headers['Retry-After'] * 1000;
                strapi.log.debug(`Got 429, sleeping for ${sleep}`);
                await wait(sleep);
                delay = 1000; // reset 503 back-off
            }
            else if (status == 503 /*Service Unavailable*/) {
                if (delay > maxDelay) {
                    throw error;
                }
                strapi.log.debug(`Got 503, sleeping for ${delay}`);
                await wait(delay);
                delay *= 2;
            }
            else {
                throw error;
            }
        }
    }
}

module.exports = {
  provider: 'backblaze-b2',
  name: 'Backblaze B2',
  auth: {
    accountId: {
      label: 'Account ID / Application Key ID',
      type: 'text'
    },
    applicationKey: {
      label: 'Application Key',
      type: 'text'
    },
    bucket: {
      label: 'Bucket Name',
      type: 'text'
    }
  },
  init: (config) => {
    let b2 = new B2({
        accountId: config.accountId,
        applicationKey: config.applicationKey
    });

    let authPromise = b2.authorize().then(res => res.data);

    const bucketPromise = authPromise.then(() => b2.getBucket({
        bucketName: config.bucket
    })).then(res => res.data.buckets[0]);

    // Refresh authentication every 6 hours
    setInterval(async () => {
        strapi.log.debug("Replacing Backblaze B2 client");
        const newB2 = new B2({
            accountId: config.accountId,
            applicationKey: config.applicationKey
        });
        await newB2.authorize();
        b2 = newB2;
        strapi.log.debug("Replaced Backblaze B2 client");
    }, 6 * 60 * 60 * 1000);

    return {
      upload: async (file) => {
        const { downloadUrl } = await authPromise;
        const { bucketId, bucketName } = await bucketPromise;

        strapi.log.debug("Getting Backblaze B2 upload URL");
        const { uploadUrl, authorizationToken } = await callWithBackOff(() => b2.getUploadUrl(bucketId));

        const path = file.path ? `${file.path}/` : '';
        const fileName = `${path}${file.hash}${file.ext}`;
        strapi.log.debug("Uploading file to Backblaze B2: %s", path);
        await callWithBackOff(() => b2.uploadFile({
            uploadUrl,
            uploadAuthToken: authorizationToken,
            mime: file.mime,
            fileName,
            data: Buffer.from(file.buffer, 'binary'),
        }));
        strapi.log.debug("Backblaze B2 upload done: %s", fileName);
        file.url = `${downloadUrl}/file/${bucketName}/${fileName}`;
      },

      delete: async (file) => {
        strapi.log.debug("Deletion called for %o", file);
        const path = file.path ? `${file.path}/` : '';
        const fileNameToDelete = `${path}${file.hash}${file.ext}`;
        const { bucketId } = await bucketPromise;

        strapi.log.debug("Getting Backblaze B2 file versions for deletion of: %s", fileNameToDelete);
        const { files: fileVersions } = await b2.listFileVersions({
            bucketId,
            startFileName: fileNameToDelete,
            prefix: fileNameToDelete
        }).then(res => res.data);

        const deletionPromises = [];
        for (const version of fileVersions) {
            if (version.fileName === fileNameToDelete) {
                deletionPromises.push(b2.deleteFileVersion(version));
            } else {
                break;
            }
        }
        strapi.log.debug('Deleting %d file version(s) of Backblaze B2 file: %s', deletionPromises.length, fileNameToDelete);
        await Promise.all(deletionPromises);
        strapi.log.debug("Deleted Backblaze B2 file: %s", fileNameToDelete);
      }
    };
  }
};
