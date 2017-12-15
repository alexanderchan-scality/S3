const { errors, s3middleware } = require('arsenal');
const MD5Sum = s3middleware.MD5Sum;

const GCP = require('./GCP');
const AwsClient = require('./AwsClient');
const { prepareStream } = require('../../api/apiUtils/object/prepareStream');
const { logHelper, removeQuotes } = require('./utils');
const { config } = require('../..//Config');

const missingVerIdInternalError = errors.InternalError.customizeDescription(
    'Invalid state. Please ensure versioning is enabled ' +
    'in GCP for the location constraint and try again.');

class GcpClient extends AwsClient {
    constructor(config) {
        super(config);
        this._mpuBucketName = config.mpuBucket;
        this._overflowName = config.overflowBucket;
        this._gcpBucketName = this._awsBucketName;
        this._createGcpKey = this._createAwsKey.bind(this);
        this._client = new GCP(this._s3Params);
        this._type = 'GCP';
    }

    createMPU(key, metaHeaders, bucketName, websiteRedirectHeader, contentType,
        cacheControl, contentDisposition, contentEncoding, log, callback) {
        const metaHeadersTrimmed = {};
        Object.keys(metaHeaders).forEach(header => {
            if (header.startsWith('x-amz-meta-')) {
                const headerKey = header.substring(11);
                metaHeadersTrimmed[headerKey] = metaHeaders[header];
            }
        });
        Object.assign(metaHeaders, metaHeadersTrimmed);
        const gcpBucket = this._mpuBucketName;
        const gcpKey = this._createGcpKey(bucketName, key, this._bucketMatch);
        const params = {
            Bucket: gcpBucket,
            Key: gcpKey,
            Metadata: metaHeaders,
            ContentType: contentType,
            CacheControl: cacheControl,
            ContentDisposition: contentDisposition,
            ContentEncoding: contentEncoding,
        };
        return this._client.createMultipartUpload(params, (err, mpuResObj) => {
            if (err) {
                logHelper(log, 'error', 'err from data backend',
                  err, this._dataStoreName);
                return callback(errors.ServiceUnavailable
                  .customizeDescription('Error returned from ' +
                  `${this._type}: ${err.message}`)
                );
            }
            return callback(null, mpuResObj);
        });
    }

    completeMPU(jsonList, mdInfo, key, uploadId, bucketName, log, callback) {
        const gcpBucket = this._gcpBucketName;
        const gcpKey = this._createGcpKey(bucketName, key, this._bucketMatch);
        const partArray = [];
        const partList = jsonList.Part;
        // if jsonList has versionId associated with each part,
        // that will facilitate the deletion on mpu complete
        partList.forEach(partObj => {
            const partParams = {
                PartName:
                    this._createMpuKey(gcpKey, uploadId, partObj.PartNumber[0]),
                PartNumber: partObj.PartNumber[0],
                ETag: partObj.ETag[0],
            };
            partArray.push(partParams);
        });

        const mpuParams = {
            Bucket: gcpBucket,
            MPU: this._mpuBucketName,
            Overflow: this._overflowName,
            Key: gcpKey,
            UploadId: uploadId,
            MultipartUpload: { Parts: partArray },
        };
        const completeObjData = { key: gcpKey };
        return this._client.completeMultipartUpload(mpuParams,
        (err, completeMpuRes) => {
            if (err) {
                logHelper(log, 'error', 'err from data backend on ' +
                'completeMPU', err, this._dataStoreName);
                return callback(errors.ServiceUnavailable
                  .customizeDescription('Error returned from ' +
                  `${this._type}: ${err.message}`)
                );
            }
            if (!completeMpuRes.VersionId) {
                logHelper(log, 'error', 'missing version id for data ' +
                'backend object', missingVerIdInternalError,
                    this._dataStoreName);
                return callback(missingVerIdInternalError);
            }
            return this._client.headObject({ Bucket: gcpBucket, key: gcpKey },
            (err, objHeaders) => {
                if (err) {
                    logHelper(log, 'error', 'err from data backend on ' +
                    'completeMPU', err, this._dataStoreName);
                    return callback(errors.ServiceUnavailable
                      .customizeDescription('Error returned from ' +
                      `${this._type}: ${err.message}`)
                    );
                }
                completeObjData.eTag = removeQuotes(completeMpuRes.ETag);
                completeObjData.dataStoreVersionId = completeMpuRes.VersionId;
                completeObjData.contentLength = objHeaders.ContentLength;
                return callback(null, completeObjData);
            });
        });
    }

    uploadPart(request, streamingV4Params, stream, size, key, uploadId,
    partNumber, bucketName, log, callback) {
        let hashedStream = stream;
        if (request) {
            const partStream = prepareStream(request, streamingV4Params,
                log, callback);
            hashedStream = new MD5Sum();
            partStream.pip(hashedStream);
        }

        const gcpBucket = this._mpuBucketName;
        const gcpKey = this._createGcpKey(bucketName, key, this._bucketMatch);
        const params = { Bucket: gcpBucket, Key: gcpKey, UploadId: uploadId,
            Body: hashedStream, ContentLength: size, PartNumber: partNumber };
        return this._client.uploadPart(params, (err, partResObj) => {
            if (err) {
                logHelper(log, 'error', 'err from data backend ' +
                  'on uploadPart', err, this._dataStoreName);
                return callback(errors.ServiceUnavailable
                  .customizeDescription('Error returned from ' +
                  `${this._type}: ${err.message}`)
                );
            }
            const noQuotesETag = removeQuotes(partResObj.ETag);
            const dataRetrievalInfo = {
                key: gcpKey,
                dataStoreType: 'gcp',
                dataStoreName: this._dataStoreName,
                dataStoreETag: noQuotesETag,
            };
            return callback(null, dataRetrievalInfo);
        });
    }

    uploadPartCopy(request, gcpSourceKey, sourceLocationConstraintName, log,
    callback) {
        const destBucketName = request.bucketName;
        const destObjectKey = request.objectKey;
        const destGcpKey = this._createGcpKey(destBucketName, destObjectKey,
        this._bucketMatch);

        const sourceGcpBucketName =
            config.getGcpBucketName(sourceLocationConstraintName);

        const uploadId = request.query.uploadId;
        const partNumber = request.query.partNumber;
        const copySourceRange = request.headers['x-amz-copy-source-range'];

        if (copySourceRange) {
            return callback(errors.NotImplemented
              .customizeDescription('Error returned from ' +
                `${this._type}: copySourceRange not implemented`)
            );
        }

        const params = {
            Bucket: this._mpuBucketName,
            CopySource: `${sourceGcpBucketName}/${gcpSourceKey}`,
            Key: destGcpKey,
            UploadId: uploadId,
            PartNumber: partNumber,
        };
        return this._client.uploadPartCopy(params, (err, res) => {
            if (err) {
                if (err.code === 'AccesssDenied') {
                    logHelper(log, 'error', 'Unable to access ' +
                    `${sourceGcpBucketName} ${this._type} bucket`, err,
                    this._dataStoreName);
                    return callback(errors.AccessDenied
                      .customizeDescription('Error: Unable to access ' +
                      `${sourceGcpBucketName} ${this._type} bucket`)
                    );
                }
                logHelper(log, 'error', 'error from data backend on ' +
                'uploadPartCopy', err, this._dataStoreName);
                return callback(errors.ServiceUnavailable
                  .customizeDescription('Error returned from ' +
                  `${this._type}: ${err.message}`)
                );
            }
            const eTag = removeQuotes(res.CopyPartResult.ETag);
            return callback(null, eTag);
        });
    }

    listParts(key, uploadId, bucketName, partNumberMarker, maxParts, log,
    callback) {
        const gcpBucket = this._gcpBucketName;
        const gcpKey = this._createGcpKey(bucketName, key, this._bucketMatch);
        const getParams = {
            Bucket: gcpBucket,
            Key: gcpKey,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
            MaxParts: maxParts,
        };
        return this._client.listParts(getParams, (err, listResults) => {
            if (err) {
                logHelper(log, 'error', 'err from data backend' +
                    'on listParts', err, this._dataStoreName);
                return callback(errors.ServiceUnavailable
                  .customizeDescription('Error returned from ' +
                    `${this._type}: ${err.message}`)
                );
            }
            const storedParts = {};
            storedParts.IsTruncated = listResults.isTruncated;
            storedParts.Contents = [];
            storedParts.Contents = listResults.Parts.map(item => {
                const noQuotesETag = removeQuotes(item.ETag);
                return {
                    PartNumber:
                        parseInt(item.Key.replace(listResults.Prefix, ''), 10),
                    Value: {
                        Size: item.Size,
                        Etag: noQuotesETag,
                        LastModified: item.LastModified,
                    },
                };
            });
            return callback(null, storedParts);
        });
    }

    abortMPU(key, uploadId, bucketName, log, callback) {
        const gcpBucket = this._gcpBucketName;
        const gcpKey = this._createGcpKey(bucketName, key, this._bucketMatch);
        // easiest method will be to list objects with prefix key-uploadid
        // and remove each of those.
        const getParams = {
            Bucket: gcpBucket,
            MPU: this._mpuBucketName,
            Overflow: this._overflowName,
            Key: gcpKey,
            UploadId: uploadId,
        };
        return this._client.abortMultipartUpload(getParams, err => {
            if (err) {
                logHelper(log, 'error', 'err from data backend ' +
                    'on abortMPU', err, this._dataStoreName);
                return callback(errors.ServiceUnavailable
                  .customizeDescription('Error returned from ' +
                    `${this._type}: ${err.message}`)
                );
            }
            return callback();
        });
    }
}

module.exports = GcpClient;
