// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrandingProvider, useBranding, BrandLogo } from "./branding";
afterEach(()=>{cleanup();vi.unstubAllGlobals();document.querySelector('[data-platform-icon]')?.remove()});
function Sample(){const brand=useBranding();return <><h1>{brand.name}</h1><BrandLogo /><button onClick={()=>brand.update({name:"New brand",logo:"data:image/png;base64,sample"})}>Save brand</button></>}
it("loads public branding and applies accepted changes to title and browser icon", async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({name:"Initial brand"}),{headers:{"Content-Type":"application/json"}})));
 const {container}=render(<BrandingProvider><Sample /></BrandingProvider>);
 await screen.findByText("Initial brand");
 fireEvent.click(screen.getByRole("button",{name:"Save brand"}));
 expect(screen.getByText("New brand")).toBeTruthy();
 expect(document.title).toBe("New brand 线路控制台");
 expect(document.querySelector<HTMLLinkElement>('[data-platform-icon]')?.href).toBe("data:image/png;base64,sample");
 await waitFor(()=>expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,sample"));
});
it("does not let an older initial read overwrite newly saved branding",async()=>{
 let finish!:(response:Response)=>void;
 vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve})));
 render(<BrandingProvider><Sample /></BrandingProvider>);
 fireEvent.click(screen.getByRole("button",{name:"Save brand"}));
 await act(async()=>finish(new Response(JSON.stringify({name:"Old brand"}))));
 expect(screen.getByText("New brand")).toBeTruthy();
 expect(screen.queryByText("Old brand")).toBeNull();
});
