// Test SkySys Push API directly
// Usage: node test/sky-push-test.js
// Set env vars or edit inline: USERNAME, PASSWORD, COOKIES

const SKY_URL = 'https://skysysx.net';
const USERNAME = process.env.USERNAME || 'test_user';
const PASSWORD = process.env.PASSWORD || 'test_pass';
const COOKIES = process.env.COOKIES || 'sessionid=abc123; csrftoken=xyz';

function b64(str) {
    return Buffer.from(str, 'utf-8').toString('base64');
}

async function main() {
    console.log('=== SkySys Push API Test ===\n');
    console.log('Username:', USERNAME);
    console.log('Password:', PASSWORD);
    console.log('Cookies:', COOKIES);
    console.log();

    // Step 1: Push cookies
    console.log('--- Step 1: Push cookies ---');
    var payload = USERNAME + ':' + PASSWORD + '|||' + COOKIES + '||';
    var encoded = b64(payload);
    console.log('Payload (decoded):', payload);
    console.log('Payload (base64):', encoded);
    console.log();

    var pushRes = await fetch(SKY_URL + '/e/boss', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'accounts=' + encoded
    });
    var pushData = await pushRes.json();
    console.log('Status:', pushRes.status);
    console.log('Response:', JSON.stringify(pushData, null, 2));
    console.log();

    var jobId = pushData.job_id;
    if (!jobId) {
        console.log('ERROR: No job_id in response');
        return;
    }
    console.log('Job ID:', jobId);
    console.log();

    // Step 2: Poll job status
    console.log('--- Step 2: Poll status ---');
    var maxPolls = 30;
    for (var i = 0; i < maxPolls; i++) {
        var statusRes = await fetch(SKY_URL + '/api/status/' + jobId);
        var statusData = await statusRes.json();
        console.log('Poll', i + 1, '— Status:', statusRes.status);
        console.log('Response:', JSON.stringify(statusData, null, 2));
        console.log();

        if (statusData.status === 'done') {
            console.log('=== RESULT ===');
            console.log('Success count:', statusData.data ? statusData.data.success_count : 'N/A');
            console.log('Failed count:', statusData.data ? statusData.data.failed_count : 'N/A');
            console.log('Elapsed (s):', statusData.elapsed_seconds);
            break;
        }
        if (statusData.status === 'failed' || statusData.status === 'error') {
            console.log('Push failed');
            break;
        }
        var delay = statusData.status === 'staging' ? 5000 : 2000;
        console.log('Waiting ' + delay + 'ms...');
        await new Promise(function(r) { setTimeout(r, delay); });
    }
}

main().catch(function(e) {
    console.error('Fatal error:', e);
});
