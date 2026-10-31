// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumericInput } from "./numeric-input";
afterEach(cleanup);
it("preserves partial numeric edits and reports raw input without committing", () => {
 const commit=vi.fn(), raw=vi.fn();
 const {rerender}=render(<NumericInput aria-label="数量" value={7} onValueChange={commit} onInputText={raw}/>);
 const field=screen.getByRole("spinbutton") as HTMLInputElement;
 fireEvent.change(field,{target:{value:"-"}}); fireEvent.blur(field);
 expect(field.value).toBe("-"); expect(raw).toHaveBeenLastCalledWith("-"); expect(commit).not.toHaveBeenCalled(); expect(field.validity.valid).toBe(false);
 rerender(<NumericInput resetKey={1} aria-label="数量" value={7} onValueChange={commit} onInputText={raw}/>);
 expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
});
it("enforces native range and integer validity, preserves exact values, and bounds keyboard steps", () => {
 const commit=vi.fn(); render(<NumericInput aria-label="数量" value={2} min={1} max={3} precision={0} onValueChange={commit}/>);
 const field=screen.getByRole("spinbutton") as HTMLInputElement;
 fireEvent.change(field,{target:{value:"2.5"}}); expect(commit).toHaveBeenLastCalledWith(2.5); expect(field.validity.valid).toBe(false);
 fireEvent.change(field,{target:{value:"9"}}); expect(field.validity.valid).toBe(false);
 fireEvent.keyDown(field,{key:"ArrowUp"}); expect(commit).toHaveBeenLastCalledWith(3); expect(field.validity.valid).toBe(true);
 fireEvent.change(field,{target:{value:""}}); expect(commit).toHaveBeenLastCalledWith(null);
});
it("notifies accepted values before raw-edit observers reconcile form state", () => {
 let accepted = 1;
 const observed:number[]=[];
 render(<NumericInput value={1} onValueChange={value=>{accepted=value!;}} onInputText={()=>observed.push(accepted)}/>);
 fireEvent.change(screen.getByRole("spinbutton"),{target:{value:"4"}});
 fireEvent.change(screen.getByRole("spinbutton"),{target:{value:"-"}});
 expect(observed).toEqual([4,4]);
});
