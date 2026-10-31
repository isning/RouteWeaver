const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(require('path').join(__dirname, '../prototype/index.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map();
class Element {
 constructor(key=''){this.key=key;this.value='';this.hidden=false;this.checked=false;this.disabled=false;this.textContent='';this.listeners={};this.attributes={};this.classList={toggle(){},add(){}};this.children=[];this.isConnected=true;}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn)}
 trigger(type){for(const fn of this.listeners[type]||[])fn({preventDefault(){}})}
 setAttribute(k,v){this.attributes[k]=v} removeAttribute(k){delete this.attributes[k]}
 setCustomValidity(message){this.validationMessage=message}
 reportValidity(){if(this.key==='#route-form')return !!get('#route-name-input').value&&!get('#route-name-input').validationMessage;return true;}
 focus(){} scrollIntoView(){} getClientRects(){return [1]} replaceChildren(){this.children=[]} append(...children){this.children.push(...children)}
 querySelector(s){return get(s)} querySelectorAll(){return []} showModal(){this.open=true} close(){this.open=false;this.trigger('close')}
}
function get(s){if(!nodes.has(s))nodes.set(s,new Element(s));return nodes.get(s)}
const tests=`
// Logic-only harness. No browser or rendered DOM. Rendering helpers are excluded.
renderRoute=()=>{};showRoute=()=>{};showPage=()=>{};toast=()=>{};openDialog=()=>{};closeDialog=()=>{};
const passed=[];
scenario='first';hasProfile=false;profilePublished=false;profileDraft=null;
editProfile(true);$('#profile-name-input').value='旅行配置';$('#default-connection').value='fra';$('#ai-connection').value='fra';$('#enable-ai').checked=true;$('#dns-policy').value='跟随客户端';
retainProfileDraft();previewProfile();$('#back-to-profile-editor').trigger('click');
assert.strictEqual($('#profile-name-input').value,'旅行配置');assert.strictEqual($('#dns-policy').value,'跟随客户端');assert.strictEqual($('#enable-ai').checked,true);assert.strictEqual($('#profile-setup-fields').hidden,false);assert.strictEqual(profilePublished,false);
passed.push('first subscription draft → preview → return preserves all values and remains unpublished');
hasRoute=false;routePublished=false;routeDraft=null;otherRoutes=[];
editRoute(true);$('#route-name-input').value='旅行线路';$('#rate-input').value='3';$('#audience-input').value='admin';$('#relay-field').hidden=false;
assert.strictEqual(retainRouteDraft(),true);previewRoute();$('#back-to-route-editor').trigger('click');
assert.strictEqual($('#route-name-input').value,'旅行线路');assert.strictEqual($('#rate-input').value,'3');assert.strictEqual($('#audience-input').value,'admin');assert.strictEqual($('#relay-field').hidden,false);assert.strictEqual(routePublished,false);
passed.push('first route draft → preview → return preserves name, path, rate and audience');
route={...initialRoute};routeDraft={...route,rate:'1'};hasRoute=true;routePublished=true;otherRoutes=[];
editRoute(true);$('#route-name-input').value='备用线路';assert.strictEqual(retainRouteDraft(),true);
assert.strictEqual(otherRoutes.length,1);assert.strictEqual(otherRoutes[0].route.name,'FRA → UK');assert.strictEqual(otherRoutes[0].published,true);assert.strictEqual(otherRoutes[0].draft.rate,'1');assert.strictEqual(route.name,'备用线路');assert.strictEqual(routePublished,false);
passed.push('new route remains separate from original published route and original pending draft');
$('#discard-route').trigger('click');assert.strictEqual(route.name,'FRA → UK');assert.strictEqual(routePublished,true);assert.strictEqual(hasRoute,true);assert.strictEqual(routeDraft.rate,'1');assert.strictEqual(otherRoutes.length,0);
passed.push('discarding new route restores existing published route with its pending changes');
scenario='failure';profile={...initialProfile};hasProfile=true;profilePublished=true;profileDraft={...profile,enableAI:true};renderProfile();assert.strictEqual($('#personal-error').hidden,false);
profileDraft.enableAI=false;renderProfile();assert.strictEqual($('#personal-error').hidden,true);previewProfile();assert.strictEqual($('#preview-ai-resource').hidden,true);assert.strictEqual($('#profile-preview-error').hidden,true);
profileDraft.enableAI=true;$('#discard-profile').trigger('click');assert.strictEqual($('#personal-error').hidden,true);assert.strictEqual(profilePublished,true);assert.strictEqual(profile.default,'tokyo');
passed.push('draft-specific error disappears when affected rule is removed or draft is discarded');
editProfile(false);$('#enable-ai').checked=false;$('#enable-ai').trigger('change');assert.strictEqual($('#advanced-ai-rule').hidden,true);assert.strictEqual($('#ai-connection-row').hidden,true);
passed.push('disabling ChatGPT updates both normal selection and advanced rule display');
editRoute(false);$('#route-name-input').value='重复路径';$('#entry-input').value='nl';$('#exit-input').value='nl';$('#relay-field').hidden=true;const before=JSON.stringify(routeDraft);assert.strictEqual(retainRouteDraft(),false);assert.strictEqual($('#path-error').hidden,false);assert.strictEqual(JSON.stringify(routeDraft),before);assert.strictEqual($('#route-name-input').value,'重复路径');
passed.push('duplicate path blocks save while retaining form values and previous draft');
console.log(JSON.stringify({type:'logic tests with stubbed DOM, not browser QA',passed},null,2));
`;
const instrumented=source.replace(/const initial=new URLSearchParams[\s\S]*?showPage\(\['admin','personal','usage','sources'\][\s\S]*?false\);/,tests);
assert(instrumented.includes('Logic-only harness'));
vm.runInNewContext(instrumented,{assert,console,document:{querySelector:get,querySelectorAll:()=>[],createElement:()=>new Element(),activeElement:null},window:{scrollTo(){}},setTimeout,clearTimeout,URLSearchParams});
