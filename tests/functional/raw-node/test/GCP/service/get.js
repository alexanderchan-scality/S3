const assert = require('assert');
const async = require('async');
const { GCP } = require('../../../../../../lib/data/external/GCP');
const { makeGcpRequest } = require('../../../utils/makeRequest');
const { getRealAwsConfig } =
    require('../../../../aws-node-sdk/test/support/awsConfig');

const endpoint = 'storage.googleapis.com';
const credentialOne = 'gcpbackend';
const credentialTwo = 'gcpbackend2';

describe('GCP Service: GET Service', function testSuite() {
    this.timeout(20000);
    let gcpClient;
    let config;

    describe('when user is unauthorized', () => {
        it('should return 400 and MissingSecurityHeader', done => {
            gcpClient = new GCP({ endpoint });
            gcpClient.makeUnauthenticatedRequest('listBuckets',
            err => {
                assert(err);
                assert.strictEqual(err.statusCode, 400);
                assert.strictEqual(err.code, 'MissingSecurityHeader');
                return done();
            });
        });
    });

    describe('when user has invalid credentials', () => {
        it('should return 403 and InvalidAccessKeyId ' +
        'if accessKeyId is invalid', done => {
            const invalidConfig = {
                endpoint,
                accessKeyId: 'wrong',
                secretAccessKey: 'wrong',
            };
            gcpClient = new GCP(invalidConfig);
            gcpClient.listBuckets((err, res) => {
                assert(err);
                assert.strictEqual(err.statusCode, 403);
                assert.strictEqual(err.code, 'InvalidAccessKeyId');
                return done();
            });
        });

        it('should return 403 and SignatureDoesNotMatch ' +
        'if credential is polluted', done => {
            config = getRealAwsConfig(credentialOne);
            const pollutedConfig = config;
            pollutedConfig.credentials.secretAccessKey = 'wrong';
            gcpClient = new GCP(pollutedConfig);
            gcpClient.listBuckets((err, res) => {
                assert(err);
                assert.strictEqual(err.statusCode, 403);
                assert.strictEqual(err.code, 'SignatureDoesNotMatch');
                return done();
            });
        });
    });

    describe('when user has credentials', () => {
        const bucketsNumbers = 5;
        let createdBuckets;
        before(done => {
            process.stdout
                .write(`testing listing with ${bucketsNumbers} buckets\n`);
            createdBuckets = Array.from(Array(bucketsNumbers).keys())
                .map(i => `getservicebuckets-${i}`)
            config = getRealAwsConfig(credentialOne);
            gcpClient = new GCP(config);
            async.eachSeries(createdBuckets, (bucketName, next) => {
                makeGcpRequest({
                    method: 'PUT',
                    bucket: bucketName,
                    hostname: endpoint,
                    authCredentials: config.credentials,
                }, err => next(err));
            }, err => {
                if (err) {
                    process.stdout
                        .write(`err creating buckets: ${err.code}\n`);
                } else {
                    process.stdout.write('Created buckets\n');
                }
                return done(err);
            });
        });

        after(done => {
            async.eachSeries(createdBuckets, (bucketName, next) => {
                makeGcpRequest({
                    method: 'DELETE',
                    bucket: bucketName,
                    hostname: endpoint,
                    authCredentials: config.credentials,
                }, err => next(err));
            }, err => {
                if (err) {
                    process.stdout
                        .write(`err deleting buckets: ${err.code}\n`);
                } else {
                    process.stdout.write('Deleted buckets\n');
                }
                return done(err);
            });
        });

        it('should list buckets concurrently', done => {
            async.times(20, (n, next) => {
                gcpClient.listBuckets((err, res) => {
                    assert.equal(err, null,
                        `Expected success, but got error ${err}`);
                    return next(err);
                });
            }, err => {
                assert.ifError(err, `error listing buckets: ${err}`);
                return done();
            })
        });

        describe('two accounts are given', () => {
            let gcpClient2;
            before(done => {
                const config2 = getRealAwsConfig(credentialTwo);
                gcpClient2 = new GCP(config2);
                return done();
            });

            const filterFn = bucket => createdBuckets.indexOf(bucket.name) > -1;

            it.only('should not return other account\'s bucket list', done => {
                gcpClient2.listBuckets((err, res) => {
                    assert.equal(err, null,
                        `Expected success, but got ${err}`);
                    const hasSameBuckets = res.Buckets.filter(filterFn).length;
                    assert.strictEqual(hasSameBuckets, 0,
                        'Contains buckets from other accounts');
                    return done();
                });
            });
        });
    });
});
