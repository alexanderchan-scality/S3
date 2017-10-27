const assert = require('assert');
const { checkExternalBackend } = require('../../../lib/data/external/utils');
const { externalBackendHealthCheckInterval } = require('../../../constants');
const awsLocations = [
    'aws-test',
];

const statusSuccess = {
    versioningStatus: 'Enabled',
    message: 'Congrats! You own the bucket',
};

const statusFailure = {
    versioningStatus: 'Suspended',
    error: 'Versioning must be enabled',
    external: true,
};

function getClients(isSuccess) {
    const status = isSuccess ? statusSuccess : statusFailure;
    return {
        'aws-test': {
            healthcheck: (location, cb) => cb(null, { 'aws-test': status }),
        },
    };
}


describe('Testing _checkExternalBackend', function describeF() {
    this.timeout(150000);
    beforeEach(done => {
        const clients = getClients(true);
        return checkExternalBackend(clients, awsLocations, 'aws_s3', done);
    });
    it('should not refresh response before a minute', done => {
        const clients = getClients(false);
        return checkExternalBackend(clients, awsLocations, 'aws_s3',
        (err, res) => {
            if (err) {
                return done(err);
            }
            assert.strictEqual(res['aws-test'], statusSuccess);
            return done();
        });
    });

    it('should refresh response after a minute', done => {
        const clients = getClients(false);
        return setTimeout(() => {
            checkExternalBackend(clients, awsLocations, 'aws_s3',
            (err, res) => {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(res['aws-test'], statusFailure);
                return done();
            });
        }, externalBackendHealthCheckInterval);
    });
});
