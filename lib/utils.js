// @ts-check

'use strict';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const MAX_DELAY = 16000;
const INITIAL_DELAY = 1000;

const callWithBackOff = async function callWithBackOff(request) {
    let delay = 1000;
    while (true) {
        try {
            return await request();
        } catch (error) {
            if (!error.response) {
                throw error;
            }
            const { response } = error;
            const status = response.status;
            if (status == 429 /*Too Many Requests*/) {
                const sleep = response.headers['Retry-After'] * 1000; // Convert to milliseconds
                strapi.log.debug(`Got 429, sleeping for ${sleep}`);
                await wait(sleep);
                delay = INITIAL_DELAY; // reset 503 back-off
            }
            else if (status == 503 /*Service Unavailable*/) {
                if (delay > MAX_DELAY) {
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
    wait,
    callWithBackOff,
    INITIAL_DELAY,
    MAX_DELAY
}