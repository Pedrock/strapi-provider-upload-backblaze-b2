# strapi-provider-upload-backblaze-b2

Backblaze B2 provider for Strapi upload.

## Installation

```
npm install strapi-provider-upload-backblaze-b2
````

Then, visit /admin/plugins/upload/configurations/development on your web browser and configure the provider.

Or

Add `./extensions/upload/config/settings.json` file with config:

```
{
  "provider": "backblaze-b2",
  "providerOptions": {
    "accountId": "keyID",
    "applicationKey": "applicationKey",
    "bucket": "bucketName"
  }
}
```


## License

The MIT License (MIT)

Copyright (c) 2019 Pedro Câmara
