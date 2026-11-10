import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AppField, AppForm } from "../../src/ui-patterns/form";
import { PolicyDateInput } from "../../src/PolicyDateInput";
import "../../src/shadcn.css";

// Component lifecycle fixture, not evidence any live task disables an open picker.
function Sample() {
  const initial = "2026-02-03T04:05:06.123456789+05:30";
  const [disabled, setDisabled] = useState(false);
  const [value, setValue] = useState(initial);
  const [changes, setChanges] = useState(0);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState("");
  return (
    <main className="space-y-6 bg-background p-8 text-foreground">
      <h1>Synthetic disabled date lifecycle</h1>
      <AppForm<{ date: string }>
        disabled={disabled}
        initialValues={{ date: initial }}
        onValuesChange={(_, values) => {
          setValue(values.date);
          setChanges((n) => n + 1);
        }}
        onFinish={(values) => setSubmitted(values.date)}
      >
        <AppField name="date" label="到期时间">
          <PolicyDateInput
            onPendingChange={setPending}
            onOpenChange={(open) => {
              // Re-enable as soon as the disabled owner's close commits, before paint.
              if (!open && disabled)
                queueMicrotask(() => flushSync(() => setDisabled(false)));
            }}
          />
        </AppField>
        <button type="submit">保存</button>
      </AppForm>
      <button
        id="disable-owner"
        type="button"
        onClick={() => setDisabled(true)}
      >
        Disable owner
      </button>
      <button id="new-task" type="button">
        Newer task
      </button>
      <output data-testid="stored">{value}</output>
      <output data-testid="changes">{changes}</output>
      <output data-testid="pending">{String(pending)}</output>
      <output data-testid="submitted">{submitted}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Sample />);
