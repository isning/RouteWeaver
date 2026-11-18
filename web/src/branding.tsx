import { setDisplayTimezone } from "./model";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Zap } from "lucide-react";
type Branding = { name: string; logo?: string; timezone?: string; registration?: string };
const defaults: Branding = { name: "RouteWeaver",timezone:"UTC+8",registration:"invite" };
const Context = createContext({ ...defaults, update: (_value: Branding) => {} });
export const useBranding = () => useContext(Context);
export function BrandingProvider({children}:{children:ReactNode}) {
 const [value,setValue]=useState(defaults);
 const revision=useRef(0);
 const update=(next:Branding)=>{revision.current++;setDisplayTimezone(next.timezone || "UTC+8");setValue(next)};
 useEffect(()=>{let active=true;void fetch("/api/branding",{credentials:"same-origin",cache:"no-store"}).then(async response=>{
  if (!response.ok) return;
  const next=await response.json();if(active && revision.current===0 && typeof next.name==="string" && next.name.trim()){
   const timezone=typeof next.timezone==="string"?next.timezone:"UTC+8";
   setDisplayTimezone(timezone);
   setValue({name:next.name,logo:typeof next.logo==="string"?next.logo:undefined,timezone,registration:next.registration === "closed" ? "closed" : "invite"});
  }
 }).catch(()=>{});return()=>{active=false};},[]);
 useEffect(()=>{
  setDisplayTimezone(value.timezone || "UTC+8");
  document.title=`${value.name} 线路控制台`;
  let icon=document.querySelector<HTMLLinkElement>('link[data-platform-icon]');
  if(value.logo){if(!icon){icon=document.createElement("link");icon.rel="icon";icon.dataset.platformIcon="true";document.head.append(icon)}icon.href=value.logo}
  else icon?.remove();
 },[value]);
 return <Context.Provider value={{...value,update}}>{children}</Context.Provider>;
}
export function BrandLogo({className="size-5"}:{className?:string}) {
 const {logo}=useBranding();const [failed,setFailed]=useState(false);
 useEffect(()=>setFailed(false),[logo]);
 return logo && !failed ? <img src={logo} alt="" className={`${className} object-contain`} onError={()=>setFailed(true)} /> : <Zap aria-hidden="true" className={className} />;
}
