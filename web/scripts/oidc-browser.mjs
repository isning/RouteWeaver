import { chromium, expect } from "@playwright/test";
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
    const startResponse = page.waitForResponse(r=>r.url()===fixture.origin+"/api/auth/oidc/start");
    await page.getByRole("button",{name:"使用 Fixture SSO 登录",exact:true}).click();
    assert.equal((await startResponse).status(),200);
    await page.waitForURL(url=>url.origin===fixture.issuer);
    const temporary = (await cookies()).find(c=>c.name===tempName);
    assert.ok(temporary && temporary.secure && temporary.httpOnly && temporary.sameSite==="Lax");
    assert.equal(temporary.path,"/");
    startCookie = temporary;
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
    await expect(page.getByRole("button",{name:fixture.totpSecret?"验证并登录":"完成单点登录",exact:true})).toBeVisible();
    assert.equal(new URL(page.url()).search,"","React must remove callback markers");
    assert.equal(new URL(page.url()).origin,fixture.origin);
    pendingCookie = (await cookies()).find(c=>c.name===tempName);
    assert.ok(pendingCookie);
    assert.equal((await call("/api/auth/me")).status,401);
  }
  // Invalid marker proves Strict transmission behavior without authenticating.
  await context.addCookies([{name:"routeweaver_session",value:"invalid-browser-fixture",url:fixture.origin,httpOnly:true,secure:true,sameSite:"Strict"}]);
  await authorize();
  if (fixture.totpSecret) {
    const acceptedCodes = new Set([-1,0,1].map(offset=>totp(fixture.totpSecret,offset)));
    let wrongCode = "000000";
    while (acceptedCodes.has(wrongCode)) wrongCode=String(Number(wrongCode)+1).padStart(6,"0");
    await page.getByLabel("二次验证码",{exact:true}).fill(wrongCode);
    const failedResponse = page.waitForResponse(r=>r.url()===fixture.origin+"/api/auth/oidc/complete");
    await page.getByRole("button",{name:"验证并登录",exact:true}).click();
    assert.equal((await failedResponse).status(),401);
    await expect(page.getByText("单点登录未完成或验证已过期，请重新使用单点登录，或改用账号密码。",{exact:true})).toBeVisible();
    await expect(page.getByLabel("二次验证码",{exact:true})).toHaveCount(0);
    await context.addCookies([pendingCookie]);
    assert.equal((await call("/api/auth/oidc/complete",{totp:totp(fixture.totpSecret)})).status,401,"failed proof is one-use");
    assert.equal((await call("/api/auth/me")).status,401);
    await authorize();
  }
  if (fixture.totpSecret) await page.getByLabel("二次验证码",{exact:true}).fill(totp(fixture.totpSecret));
  const doneResponse = page.waitForResponse(r=>r.url()===fixture.origin+"/api/auth/oidc/complete");
  const checkedIdentity = page.waitForResponse(r=>r.url()===fixture.origin+"/api/auth/me" && r.status()===200);
  await page.getByRole("button",{name:fixture.totpSecret?"验证并登录":"完成单点登录",exact:true}).click();
  assert.equal((await doneResponse).status(),200);
  const identity = await (await checkedIdentity).json();
  assert.equal(identity.user.id,fixture.accountID);
  assert.equal(identity.user.role,"user");
  await expect(page.getByRole("button",{name:/oidc-user.*个人账号/})).toBeVisible();
  await expect(page.getByRole("button",{name:"使用 Fixture SSO 登录",exact:true})).toHaveCount(0);
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
  // Authenticated React may retain the error marker; server response is authoritative.
  await expect(page.getByRole("button",{name:/oidc-user.*个人账号/})).toBeVisible();
  assert.equal(callbackResponse.status(),303);
  assert.equal((await callbackResponse.allHeaders()).location,"/?oidc=error");
  assert.ok(!(await callbackResponse.headersArray()).some(h=>h.name.toLowerCase()==="set-cookie" && h.value.startsWith("routeweaver_session=")));
  assert.equal((await cookies()).find(c=>c.name==="routeweaver_session")?.value,session.value,"callback replay must not replace session");
  console.log("PASS production React login and cross-site callback: Lax proof, Strict exclusion/session, completion and replay"+(fixture.totpSecret?", MFA failure and success":""));
  await context.close();
} finally { await browser.close(); }

function totp(secret, offsetSteps=0) {
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits=""; for (const c of secret) bits+=alphabet.indexOf(c).toString(2).padStart(5,"0");
  const key=Buffer.from((bits.match(/.{8}/g)??[]).map(b=>parseInt(b,2)));
  const counter=Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offsetSteps));
  const digest=createHmac("sha1",key).update(counter).digest();
  const offset=digest[digest.length-1]&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,"0");
}
