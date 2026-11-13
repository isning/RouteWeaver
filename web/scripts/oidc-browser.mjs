import { chromium } from "playwright";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const fixture = JSON.parse(process.env.ROUTEWEAVER_OIDC_FIXTURE);
assert.equal(new URL(fixture.origin).hostname, "localhost");
assert.equal(new URL(fixture.issuer).hostname, "127.0.0.1");
const browser = await chromium.launch({
  chromiumSandbox: true,
  ...(process.env.ROUTEWEAVER_CHROMIUM ? { executablePath: process.env.ROUTEWEAVER_CHROMIUM } : {}),
  // Exact test certificate SPKI only. No ignoreHTTPSErrors/global TLS bypass.
  args: [`--ignore-certificate-errors-spki-list=${fixture.spki}`],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(fixture.origin);
  const call = (path, body) => page.evaluate(async ({path,body}) => {
    const r = await fetch(path, body === undefined ? {} : {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
    });
    return {status:r.status, body:await r.json()};
  }, {path,body});
  const cookies = () => context.cookies(fixture.origin);
  const tempName = "__Host-routeweaver_oidc";
  let callback, startCookie, pendingCookie;
  async function authorize() {
    const start = await call("/api/auth/oidc/start",{});
    assert.equal(start.status,200);
    const temporary = (await cookies()).find(c=>c.name===tempName);
    assert.ok(temporary && temporary.secure && temporary.httpOnly && temporary.sameSite==="Lax");
    assert.equal(temporary.path,"/");
    startCookie = temporary;
    await page.goto(start.body.authorizationUrl);
    assert.equal(new URL(page.url()).origin,fixture.issuer);
    // A committed IdP document and real user navigation, not APIRequestContext.
    callback = await page.getByRole("link",{name:"Continue to RouteWeaver"}).getAttribute("href");
    const responsePromise = page.waitForResponse(r=>r.url()===callback);
    await page.getByRole("link",{name:"Continue to RouteWeaver"}).click();
    const response = await responsePromise;
    const requestCookies = (await response.request().allHeaders()).cookie ?? "";
    assert.ok(requestCookies.includes(tempName+"="),"cross-site callback must carry Lax proof");
    assert.ok(!requestCookies.includes("routeweaver_session="),"cross-site callback must omit Strict session");
    assert.ok(!(await response.headersArray()).some(h=>h.name.toLowerCase()==="set-cookie" && h.value.startsWith("routeweaver_session=")));
    await page.waitForURL(fixture.origin+"/?oidc="+(fixture.totpSecret?"mfa":"complete"));
    pendingCookie = (await cookies()).find(c=>c.name===tempName);
    assert.ok(pendingCookie);
    assert.equal((await call("/api/auth/me")).status,401);
  }
  // Invalid marker proves Strict transmission behavior without authenticating.
  await context.addCookies([{name:"routeweaver_session",value:"invalid-browser-fixture",url:fixture.origin,httpOnly:true,secure:true,sameSite:"Strict"}]);
  await authorize();
  if (fixture.totpSecret) {
    assert.equal((await call("/api/auth/oidc/complete",{totp:"invalid"})).status,401);
    await context.addCookies([pendingCookie]);
    assert.equal((await call("/api/auth/oidc/complete",{totp:totp(fixture.totpSecret)})).status,401,"failed proof is one-use");
    assert.equal((await call("/api/auth/me")).status,401);
    await authorize();
  }
  const done = await call("/api/auth/oidc/complete",fixture.totpSecret?{totp:totp(fixture.totpSecret)}:{});
  assert.equal(done.status,200);
  const session = (await cookies()).find(c=>c.name==="routeweaver_session");
  assert.ok(session && session.secure && session.httpOnly && session.sameSite==="Strict");
  assert.ok(!(await cookies()).some(c=>c.name===tempName));
  const mePromise = page.waitForRequest(r=>r.url()===fixture.origin+"/api/auth/me");
  const me = await call("/api/auth/me");
  assert.equal(me.status,200);
  assert.equal(me.body.user.id,fixture.accountID);
  assert.equal(me.body.user.role,"user");
  assert.ok(((await (await mePromise).allHeaders()).cookie??"").includes("routeweaver_session="));
  await context.addCookies([pendingCookie]);
  const replayCompletePromise = page.waitForResponse(r=>r.url()===fixture.origin+"/api/auth/oidc/complete");
  assert.equal((await call("/api/auth/oidc/complete",{})).status,401,"consumed proof replay rejected");
  assert.ok(!(await (await replayCompletePromise).headersArray()).some(h=>h.name.toLowerCase()==="set-cookie" && h.value.startsWith("routeweaver_session=")));
  assert.equal((await cookies()).find(c=>c.name==="routeweaver_session")?.value,session.value);
  await context.addCookies([startCookie]);
  const replayResponsePromise = page.waitForResponse(r=>r.url()===callback);
  await page.goto(callback);
  const callbackResponse = await replayResponsePromise;
  await page.waitForURL(fixture.origin+"/?oidc=error");
  assert.equal(callbackResponse.status(),303);
  assert.equal((await callbackResponse.allHeaders()).location,"/?oidc=error");
  assert.ok(!(await callbackResponse.headersArray()).some(h=>h.name.toLowerCase()==="set-cookie" && h.value.startsWith("routeweaver_session=")));
  assert.equal((await cookies()).find(c=>c.name==="routeweaver_session")?.value,session.value,"callback replay must not replace session");
  console.log("PASS cross-site callback: Lax proof, Strict exclusion/session, completion and replay"+(fixture.totpSecret?", MFA failure and success":""));
  await context.close();
} finally { await browser.close(); }

function totp(secret) {
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits=""; for (const c of secret) bits+=alphabet.indexOf(c).toString(2).padStart(5,"0");
  const key=Buffer.from((bits.match(/.{8}/g)??[]).map(b=>parseInt(b,2)));
  const counter=Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const digest=createHmac("sha1",key).update(counter).digest();
  const offset=digest[digest.length-1]&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,"0");
}
