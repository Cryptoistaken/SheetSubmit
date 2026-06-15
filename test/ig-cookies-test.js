// Test IG Auto Cookies API directly
// Usage: node test/ig-cookies-test.js
// Set env vars or edit inline: USERNAME, PASSWORD, TWOFA

const IG_API = 'https://igautocookiesofficial.site/api';
const USERNAME = process.env.USERNAME || 'test_user';
const PASSWORD = process.env.PASSWORD || 'test_pass';
const TWOFA = process.env.TWOFA || 'JBSWY3DPEHPK3PXP';

async function main() {
    console.log('=== IG Auto Cookies API Test ===\n');
    console.log('Username:', USERNAME);
    console.log('Password:', PASSWORD);
    console.log('2FA Key:', TWOFA);
    console.log();

    // Step 1: Create job
    console.log('--- Step 1: Create job ---');
    var jobRes = await fetch(IG_API + '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            usernames: [USERNAME],
            commonPassword: PASSWORD,
            twofaCodes: [TWOFA]
        })
    });
    var jobData = await jobRes.json();
    console.log('Status:', jobRes.status);
    console.log('Response:', JSON.stringify(jobData, null, 2));
    console.log();

    var jobId = jobData.jobId;
    if (!jobId) {
        console.log('ERROR: No jobId in response');
        return;
    }
    console.log('Job ID:', jobId);
    console.log();

    // Step 2: Poll job status
    console.log('--- Step 2: Poll job status ---');
    var maxPolls = 30;
    for (var i = 0; i < maxPolls; i++) {
        var pollRes = await fetch(IG_API + '/jobs/' + jobId);
        var pollData = await pollRes.json();
        console.log('Poll', i + 1, '— Status:', pollRes.status);
        console.log('Response:', JSON.stringify(pollData, null, 2));
        console.log();

        var job = pollData.job;
        if (!job) {
            console.log('Unexpected response shape, breaking');
            break;
        }
        if (job.status === 'completed') {
            var acct = job.accounts && job.accounts[0];
            if (acct) {
                console.log('=== RESULT ===');
                console.log('Account status:', acct.status);
                console.log('Cookies:', acct.cookies ? acct.cookies.slice(0, 200) + '...' : 'N/A');
                console.log('CSRF Token:', acct.csrfToken || 'N/A');
                if (acct.errorReason) console.log('Error:', acct.errorReason);
            }
            break;
        }
        if (job.accounts && job.accounts[0] && job.accounts[0].status === 'failed') {
            console.log('FAILED:', job.accounts[0].errorReason || 'Unknown error');
            break;
        }
        console.log('Waiting 2s...');
        await new Promise(function(r) { setTimeout(r, 2000); });
    }
}

main().catch(function(e) {
    console.error('Fatal error:', e);
});
