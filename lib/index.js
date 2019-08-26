// @ts-check

'use strict';
const B2 = require('backblaze-b2');
const { INITIAL_DELAY, callWithBackOff, wait } = require('./utils');

const previousInit = {
  configJson: null,
  b2: null,
  authPromise: null,
  bucketPromise: null
};

const urlAndAuthTokenList = [];

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
    const configJson = JSON.stringify(config);

    let b2, authPromise, bucketPromise;

    if (configJson !== previousInit.configJson) {
      strapi.log.debug("Initializing Backblaze B2");
      b2 = new B2({
          accountId: config.accountId,
          applicationKey: config.applicationKey
      });

      authPromise = b2.authorize().then(res => res.data);

      bucketPromise = authPromise.then(() => b2.getBucket({
          bucketName: config.bucket
      })).then(res => res.data.buckets[0]);

      if (previousInit.configJson === null) {
        // Refresh authentication every 6 hours
        setInterval(async () => {
          strapi.log.debug("Replacing Backblaze B2 client");
          const newB2 = new B2({
              accountId: config.accountId,
              applicationKey: config.applicationKey
          });
          await newB2.authorize();
          previousInit.b2 = newB2;
          strapi.log.debug("Replaced Backblaze B2 client");
        }, 6 * 60 * 60 * 1000);
      }

      previousInit.configJson = configJson;
      previousInit.b2 = b2;
      previousInit.authPromise = authPromise;
      previousInit.bucketPromise = bucketPromise;
    } else {
      strapi.log.debug("Re-using previous initializion of Backblaze B2");
      b2 = previousInit.b2;
      authPromise = previousInit.authPromise;
      bucketPromise = previousInit.bucketPromise;
    }

    return {
      upload: async (file) => {
        const { downloadUrl } = await authPromise;
        const { bucketId, bucketName } = await bucketPromise;

        const path = file.path ? `${file.path}/` : '';
        const fileName = `${path}${file.hash}${file.ext}`;

        await tryToUpload(b2, bucketId, file, fileName);

        strapi.log.debug("Backblaze B2 upload done: %s", fileName);
        file.url = `${downloadUrl}/file/${bucketName}/${fileName}`;
      },

      delete: async (file) => {
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


async function tryToUpload(b2, bucketId, file, fileName) {
  let urlAndAuthToken = null;
  let delay = INITIAL_DELAY;
  for (let i = 0; i < 5; i++) {
    if (urlAndAuthToken === null) {
      if (urlAndAuthTokenList.length) {
        strapi.log.debug("Re-using Backblaze B2 upload URL");
        urlAndAuthToken = urlAndAuthTokenList.shift();
      } else {
        strapi.log.debug("Getting Backblaze B2 upload URL");
        const { uploadUrl, authorizationToken } = await callWithBackOff(() => b2.getUploadUrl(bucketId)).then(res => res.data);
        urlAndAuthToken = { uploadUrl, authorizationToken };
      }
    }

    try {
      const { uploadUrl, authorizationToken } = urlAndAuthToken;
      strapi.log.debug("Uploading file to Backblaze B2: %s", fileName);
      const { data } = await b2.uploadFile({
        uploadUrl,
        uploadAuthToken: authorizationToken,
        mime: file.mime,
        fileName,
        data: Buffer.from(file.buffer, 'binary'),
      });
      // Success - save upload URL
      urlAndAuthTokenList.push(urlAndAuthToken);
      return data;
    } catch (error) {
        if (!error.response) {
          // Failure to connect
          urlAndAuthToken = null;
          continue;
        }
        const { response } = error;
        const { status } = response;
        if (status === 401 /* Unauthorized */) {
            // Upload auth token is unauthorized. Time for a new one.
            strapi.log.debug("Backblaze B2 Upload unauthorized: %o", response.data);
            urlAndAuthToken = null;
        }
        else if (status === 408 /* Request Timeout */) {
            // Retry and hope the upload goes faster this time
            strapi.log.debug("Backblaze B2 upload resulted in 408. Waiting for %d.", delay);
            await wait(delay);
            delay *= 2;
        }
        else if (status === 429 /* Too Many Requests */) {
            // We are making too many requests
            strapi.log.debug("Backblaze B2 upload resulted in 429. Waiting for %d.", delay);
            await wait(delay);
            delay *= 2;
        }
        else {
            strapi.log.error("Failed to upload to Backblaze B2: %o", error);
            throw error;
        }
    }
  }
  throw new Error("Failed to upload to Backblaze B2");
}
