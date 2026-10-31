// @vitest-environment jsdom
import {afterEach,expect,it} from "vitest";
import {act,cleanup,render,screen,waitFor} from "@testing-library/react";
import {toast} from "sonner";
import {UIProviders} from "./ui-patterns/providers";
afterEach(cleanup);
it("renders one innermost notification host and never replays a departing account notification",async()=>{
 const host=document.createElement("div");host.dataset.sessionWorkspace="";document.body.append(host);
 const view=render(<UIProviders><UIProviders portal={host}><p>account</p></UIProviders></UIProviders>,{container:host});
 act(()=>{toast.success("Private account A result");});
 expect(await screen.findAllByText("Private account A result")).toHaveLength(1);
 expect(host.querySelector('[data-sonner-toaster]')).toBeTruthy();
 view.unmount();host.remove();
 const next=render(<UIProviders><p>account B</p></UIProviders>);
 await waitFor(()=>expect(screen.queryByText("Private account A result")).toBeNull());
 next.unmount();
});
