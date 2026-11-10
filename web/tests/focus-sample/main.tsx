import React from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
  FieldDescription,
} from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  SidebarProvider,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import "../../src/shadcn.css";

// These are real shared controls with synthetic labels, no backend or secrets.
// The sampler deliberately does not reproduce application task/layout behavior.
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
function Sample() {
  return (
    <main className="space-y-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">
        Synthetic focus samples ({dark ? "dark" : "light"})
      </h1>
      <Button variant="ghost">Keyboard starting point</Button>
      <section
        aria-label="Card surface"
        className="grid grid-cols-3 gap-8 rounded-lg bg-card p-8"
      >
        <div className="space-y-4">
          <h2>Buttons</h2>
          <Button variant="outline">Outline sample</Button>{" "}
          <Button>Primary sample</Button>{" "}
          <Button variant="destructive">Destructive sample</Button>
        </div>
        <div className="space-y-4">
          <label htmlFor="ordinary">Name sample</label>
          <Input id="ordinary" />
          <label htmlFor="invalid">Invalid name sample</label>
          <Input
            id="invalid"
            aria-invalid="true"
            aria-describedby="sample-error"
          />
          <p id="sample-error" className="text-destructive">
            Synthetic validation error
          </p>
        </div>
        <div className="space-y-6">
          <h2>Checkboxes</h2>
          <div className="flex gap-3">
            <Checkbox id="unchecked" />
            <label htmlFor="unchecked">Unchecked sample</label>
          </div>
          <div className="flex gap-3">
            <Checkbox id="checked" defaultChecked />
            <label htmlFor="checked">Checked sample</label>
          </div>
          <div className="flex gap-3">
            <Checkbox id="invalid-check" aria-invalid="true" />
            <label htmlFor="invalid-check">Invalid checkbox sample</label>
          </div>
          <div className="flex gap-3">
            <Checkbox id="invalid-checked" aria-invalid="true" defaultChecked />
            <label htmlFor="invalid-checked">Invalid checked sample</label>
          </div>
        </div>
        <FieldLabel htmlFor="invalid-plain-label">
          <Checkbox id="invalid-plain-label" aria-invalid="true" />
          Invalid plain label sample
        </FieldLabel>
        <Tabs defaultValue="active" activationMode="manual">
          <TabsList aria-label="Sample tabs">
            <TabsTrigger value="active">Active sample tab</TabsTrigger>
            <TabsTrigger value="inactive">Inactive sample tab</TabsTrigger>
          </TabsList>
          <TabsContent value="active">Synthetic tab content</TabsContent>
          <TabsContent value="inactive">Other synthetic content</TabsContent>
        </Tabs>
      </section>
      <section
        aria-label="Muted surface"
        className="flex items-center gap-8 rounded-lg bg-muted p-8"
      >
        <Button variant="outline">Muted outline sample</Button>
        <div className="w-80 space-y-4">
          <label htmlFor="muted">Muted name sample</label>
          <Input id="muted" />
        </div>
      </section>
      <section
        aria-label="Invalid checkbox cards"
        className="grid grid-cols-2 gap-8 bg-card p-8"
      >
        {[false, true].map((checked) => {
          const id = checked ? "card-checked" : "card-unchecked";
          return (
            <FieldLabel key={id} htmlFor={id}>
              <Field orientation="horizontal" data-invalid="true">
                <Checkbox
                  id={id}
                  defaultChecked={checked}
                  aria-invalid="true"
                  aria-labelledby={`${id}-title`}
                  aria-describedby={`${id}-error`}
                />
                <FieldContent>
                  <FieldTitle id={`${id}-title`}>
                    {checked
                      ? "Invalid checked card sample"
                      : "Invalid unchecked card sample"}
                  </FieldTitle>
                  <FieldDescription id={`${id}-error`}>
                    Synthetic choice needs correction
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          );
        })}
      </section>
      <SidebarProvider className="min-h-0">
        <aside
          aria-label="Sidebar surface"
          className="w-64 rounded-lg bg-sidebar p-8"
        >
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>Sidebar sample</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </aside>
      </SidebarProvider>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Sample />);
