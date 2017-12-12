const assert = require('assert');
const async = require('async');
const AWS = require('aws-sdk');
const GCP = require('../../../../../../lib/data/external/GCP');
const withV4 = require('../../support/withV4');
const BucketUtility = require('../../../lib/utility/bucket-util');
const constants = require('../../../../../../constants');
const { config } = require('../../../../../../lib/Config');
const { getRealAwsConfig } = require('../../support/awsConfig');
const { createEncryptedBucketPromise } =
    require('../../../lib/utility/createEncryptedBucket');
const { describeSkipIfNotMultiple, awsS3, gcpS3, memLocation, s3Locations,
    awsLocationEncryption, withGCP } = require('../utils');
const bucket = 'buckettestmultiplebackendobjectcopy';
const bucketAws = 'bucketawstestmultiplebackendobjectcopy';
const awsServerSideEncryptionbucket = 'awsserversideencryptionbucketobjectcopy';
const body = Buffer.from('I am a body', 'utf8');
const correctMD5 = 'be747eb4b75517bf6b3cf7c5fbb62f3a';
const emptyMD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const locMetaHeader = constants.objectLocationConstraintHeader.substring(11);

let bucketUtil;
let s3;

function putSourceObj(location, isEmptyObj, bucket, cb) {
    const key = `somekey-${Date.now()}`;
    const sourceParams = { Bucket: bucket, Key: key,
        Metadata: {
            'test-header': 'copyme',
        },
    };
    if (location) {
        sourceParams.Metadata['scal-location-constraint'] = location;
    }
    if (!isEmptyObj) {
        sourceParams.Body = body;
    }
    process.stdout.write('Putting source object\n');
    s3.putObject(sourceParams, (err, result) => {
        assert.equal(err, null, `Error putting source object: ${err}`);
        if (isEmptyObj) {
            assert.strictEqual(result.ETag, `"${emptyMD5}"`);
        } else {
            assert.strictEqual(result.ETag, `"${correctMD5}"`);
        }
        cb(key);
    });
}

function assertGetObjects(sourceKey, sourceBucket, sourceLoc, destKey,
destBucket, destLoc, awsKey, mdDirective, isEmptyObj, awsS3, awsLocation,
callback) {
    const awsBucket =
        config.locationConstraints[awsLocation].details.bucketName;
    const sourceGetParams = { Bucket: sourceBucket, Key: sourceKey };
    const destGetParams = { Bucket: destBucket, Key: destKey };
    const awsParams = { Bucket: awsBucket, Key: awsKey };
    async.series([
        cb => s3.getObject(sourceGetParams, cb),
        cb => s3.getObject(destGetParams, cb),
        cb => awsS3.getObject(awsParams, cb),
    ], (err, results) => {
        assert.equal(err, null, `Error in assertGetObjects: ${err}`);
        const [sourceRes, destRes, awsRes] = results;
        if (isEmptyObj) {
            assert.strictEqual(sourceRes.ETag, `"${emptyMD5}"`);
            assert.strictEqual(destRes.ETag, `"${emptyMD5}"`);
            assert.strictEqual(awsRes.ETag, `"${emptyMD5}"`);
        } else if (process.env.ENABLE_KMS_ENCRYPTION === 'true') {
            assert.strictEqual(sourceRes.ServerSideEncryption, 'AES256');
            assert.strictEqual(destRes.ServerSideEncryption, 'AES256');
        } else {
            assert.strictEqual(sourceRes.ETag, `"${correctMD5}"`);
            assert.strictEqual(destRes.ETag, `"${correctMD5}"`);
            assert.deepStrictEqual(sourceRes.Body, destRes.Body);
            assert.strictEqual(awsRes.ETag, `"${correctMD5}"`);
            assert.deepStrictEqual(sourceRes.Body, awsRes.Body);
        }
        if (destLoc === awsLocationEncryption) {
            assert.strictEqual(awsRes.ServerSideEncryption, 'AES256');
        } else {
            assert.strictEqual(awsRes.ServerSideEncryption, undefined);
        }
        if (mdDirective === 'COPY') {
            assert.deepStrictEqual(sourceRes.Metadata['test-header'],
                destRes.Metadata['test-header']);
        } else if (mdDirective === 'REPLACE') {
            assert.strictEqual(destRes.Metadata['test-header'],
              undefined);
        }
        if (destLoc === awsLocation) {
            assert.strictEqual(awsRes.Metadata[locMetaHeader], destLoc);
            if (mdDirective === 'COPY') {
                assert.deepStrictEqual(sourceRes.Metadata['test-header'],
                    awsRes.Metadata['test-header']);
            } else if (mdDirective === 'REPLACE') {
                assert.strictEqual(awsRes.Metadata['test-header'],
                  undefined);
            }
        }
        assert.strictEqual(sourceRes.ContentLength, destRes.ContentLength);
        assert.strictEqual(sourceRes.Metadata[locMetaHeader], sourceLoc);
        assert.strictEqual(destRes.Metadata[locMetaHeader], destLoc);
        callback();
    });
}

describeSkipIfNotMultiple('MultipleBackend object copy: AWS/GCP',
withGCP.call(this, function Suite(type)  {
    const { s3Location, s3LocationEncryption, s3Location2, s3LocationMismatch }
        = s3Locations[type];
    const s3Client = type === 'GCP' ? gcpS3 : awsS3;
    this.timeout(250000);
    withV4(sigCfg => {
        beforeEach(() => {
            bucketUtil = new BucketUtility('default', sigCfg);
            s3 = bucketUtil.s3;
            process.stdout.write('Creating bucket\n');
            if (process.env.ENABLE_KMS_ENCRYPTION === 'true') {
                s3.createBucketAsync = createEncryptedBucketPromise;
            }
            return s3.createBucketAsync({ Bucket: bucket,
              CreateBucketConfiguration: {
                  LocationConstraint: memLocation,
              },
            })
            .then(() => s3.createBucketAsync({
                Bucket: awsServerSideEncryptionbucket,
                CreateBucketConfiguration: {
                    LocationConstraint: s3LocationEncryption,
                },
            }))
            .then(() => s3.createBucketAsync({ Bucket: bucketAws,
              CreateBucketConfiguration: {
                  LocationConstraint: s3Location,
              },
            }))
            .catch(err => {
                process.stdout.write(`Error creating bucket: ${err}\n`);
                throw err;
            });
        });

        afterEach(() => {
            process.stdout.write('Emptying bucket\n');
            return bucketUtil.empty(bucket)
            .then(() => bucketUtil.empty(bucketAws))
            .then(() => bucketUtil.empty(awsServerSideEncryptionbucket))
            .then(() => {
                process.stdout.write(`Deleting bucket ${bucket}\n`);
                return bucketUtil.deleteOne(bucket);
            })
            .then(() => {
                process.stdout.write('Deleting bucket ' +
                `${awsServerSideEncryptionbucket}\n`);
                return bucketUtil.deleteOne(awsServerSideEncryptionbucket);
            })
            .then(() => {
                process.stdout.write(`Deleting bucket ${bucketAws}\n`);
                return bucketUtil.deleteOne(bucketAws);
            })
            .catch(err => {
                process.stdout.write(`Error in afterEach: ${err}\n`);
                throw err;
            });
        });

        it(`should copy an object from mem to ${type} relying on ` +
        'destination bucket location',
        done => {
            putSourceObj(memLocation, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucketAws,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'COPY',
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, memLocation, copyKey,
                        bucketAws, s3Location, copyKey, 'COPY', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it('should copy an object without location contraint from mem ' +
        `to ${type} relying on destination bucket location`,
        done => {
            putSourceObj(null, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucketAws,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'COPY',
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, undefined, copyKey,
                        bucketAws, undefined, copyKey, 'COPY', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy an object from ${type} to mem relying on destination ` +
        'bucket location',
        done => {
            putSourceObj(s3Location, false, bucketAws, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucketAws}/${key}`,
                    MetadataDirective: 'COPY',
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucketAws, s3Location, copyKey,
                      bucket, memLocation, key, 'COPY', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy an object from mem to ${type}`, done => {
            putSourceObj(memLocation, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, memLocation, copyKey, bucket,
                        s3Location, copyKey, 'REPLACE', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy an object from mem to ${type} with aws server side ` +
        'encryption', done => {
            putSourceObj(memLocation, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3LocationEncryption },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, memLocation, copyKey, bucket,
                        s3LocationEncryption, copyKey, 'REPLACE', false,
                        s3Client, s3Location, done);
                });
            });
        });

        it(`should copy an object from ${type} to mem with encryption with ` +
        'REPLACE directive but no location constraint', done => {
            putSourceObj(s3Location, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, s3Location, copyKey, bucket,
                        undefined, key, 'REPLACE', false,
                        s3Client, s3Location, done);
                });
            });
        });

        it(`should copy an object on ${type} with aws server side encryption`,
        done => {
            putSourceObj(s3Location, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3LocationEncryption },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, s3Location, copyKey, bucket,
                        s3LocationEncryption, copyKey, 'REPLACE', false,
                        s3Client, s3Location, done);
                });
            });
        });

        it(`should copy an object on ${type} with aws server side ` +
        'encrypted bucket', done => {
            putSourceObj(s3Location, false, awsServerSideEncryptionbucket,
            key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: awsServerSideEncryptionbucket,
                    Key: copyKey,
                    CopySource: `/${awsServerSideEncryptionbucket}/${key}`,
                    MetadataDirective: 'COPY',
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, awsServerSideEncryptionbucket,
                        s3Location, copyKey, awsServerSideEncryptionbucket,
                        s3LocationEncryption, copyKey, 'COPY',
                        false, s3Client, s3Location, done);
                });
            });
        });

        it(`should copy an object from mem to ${type} with encryption with ` +
        'REPLACE directive but no location constraint', done => {
            putSourceObj(null, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucketAws,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, undefined, copyKey,
                        bucketAws, undefined, copyKey, 'REPLACE', false,
                        s3Client, s3Location, done);
                });
            });
        });

        it(`should copy an object from ${type} to mem with "COPY" ` +
        'directive and aws location metadata',
        done => {
            putSourceObj(s3Location, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'COPY',
                    Metadata: {
                        'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, s3Location, copyKey, bucket,
                        memLocation, key, 'COPY', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy an object on ${type}`, done => {
            putSourceObj(s3Location, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: { 'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, s3Location, copyKey, bucket,
                        s3Location, copyKey, 'REPLACE', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy an object on ${type} location with bucketMatch equals` +
        ` false to a different ${type} location with bucketMatch equals true`,
        done => {
            putSourceObj(s3LocationMismatch, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, s3LocationMismatch, copyKey,
                        bucket, s3Location, copyKey, 'REPLACE', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy an object on AWS to a different ${type} location ` +
        'with source object READ access',
        done => {
            const s3Config2 = getRealAwsConfig(s3Location2);
            const s3ClientTwo = type === 'GCP' ?
                new GCP(s3Config2) : new AWS.S3(s3Config2);
            const copyKey = `copyKey-${Date.now()}`;
            const s3Bucket =
                config.locationConstraints[s3Location].details.bucketName;
            async.waterfall([
                // giving access to the object on the AWS side
                next => putSourceObj(s3Location, false, bucket, key =>
                  next(null, key)),
                (key, next) => s3Client.putObjectAcl(
                  { Bucket: s3Bucket, Key: key,
                  ACL: 'public-read' }, err => next(err, key)),
                (key, next) => {
                    const copyParams = {
                        Bucket: bucket,
                        Key: copyKey,
                        CopySource: `/${bucket}/${key}`,
                        MetadataDirective: 'REPLACE',
                        Metadata: {
                            'scal-location-constraint': s3Location2 },
                    };
                    process.stdout.write('Copying object\n');
                    s3.copyObject(copyParams, (err, result) => {
                        assert.equal(err, null, 'Expected success ' +
                        `but got error: ${err}`);
                        assert.strictEqual(result.CopyObjectResult.ETag,
                            `"${correctMD5}"`);
                        next(err, key);
                    });
                },
                (key, next) =>
                assertGetObjects(key, bucket, s3Location, copyKey,
                  bucket, s3Location2, copyKey, 'REPLACE', false,
                  s3ClientTwo, s3Location2, next),
            ], done);
        });

        it(`should return error AccessDenied copying an object on ${type} ` +
        `to a different ${type} account without source object READ access`,
        done => {
            putSourceObj(s3Location, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3Location2 },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, err => {
                    assert.strictEqual(err.code, 'AccessDenied');
                    done();
                });
            });
        });

        it(`should copy an object on ${type} with REPLACE`, done => {
            putSourceObj(s3Location, false, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${correctMD5}"`);
                    assertGetObjects(key, bucket, s3Location, copyKey, bucket,
                        s3Location, copyKey, 'REPLACE', false, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy a 0-byte object from mem to ${type}`, done => {
            putSourceObj(memLocation, true, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: {
                        'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${emptyMD5}"`);
                    assertGetObjects(key, bucket, memLocation, copyKey, bucket,
                        s3Location, copyKey, 'REPLACE', true, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should copy a 0-byte object on ${type}`, done => {
            putSourceObj(s3Location, true, bucket, key => {
                const copyKey = `copyKey-${Date.now()}`;
                const copyParams = {
                    Bucket: bucket,
                    Key: copyKey,
                    CopySource: `/${bucket}/${key}`,
                    MetadataDirective: 'REPLACE',
                    Metadata: { 'scal-location-constraint': s3Location },
                };
                process.stdout.write('Copying object\n');
                s3.copyObject(copyParams, (err, result) => {
                    assert.equal(err, null, 'Expected success but got ' +
                    `error: ${err}`);
                    assert.strictEqual(result.CopyObjectResult.ETag,
                        `"${emptyMD5}"`);
                    assertGetObjects(key, bucket, s3Location, copyKey, bucket,
                        s3Location, copyKey, 'REPLACE', true, s3Client,
                        s3Location, done);
                });
            });
        });

        it(`should return error if ${type} source object has ` +
        'been deleted', done => {
            putSourceObj(s3Location, false, bucket, key => {
                const s3Bucket =
                    config.locationConstraints[s3Location].details.bucketName;
                s3Client.deleteObject({ Bucket: s3Bucket, Key: key }, err => {
                    assert.equal(err, null, 'Error deleting object from AWS: ' +
                        `${err}`);
                    const copyKey = `copyKey-${Date.now()}`;
                    const copyParams = { Bucket: bucket, Key: copyKey,
                        CopySource: `/${bucket}/${key}`,
                        MetadataDirective: 'REPLACE',
                        Metadata: { 'scal-location-constraint': s3Location },
                    };
                    process.stdout.write('Copying object\n');
                    s3.copyObject(copyParams, err => {
                        assert.strictEqual(err.code, 'ServiceUnavailable');
                        done();
                    });
                });
            });
        });
    });
}));
