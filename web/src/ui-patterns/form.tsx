import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import RcForm, {
  Field as RcField,
  FieldContext,
  List as FormList,
  useForm,
  useWatch,
  type FieldProps,
  type FormInstance,
  type FormProps,
  type Meta,
} from "@rc-component/form";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { cn } from "@/lib/utils";

const DisabledContext = createContext(false);

type SubmitFocus = {
  form: HTMLFormElement;
  origin: Element | null;
  owner: object;
  release: () => void;
};

function canRecoverFocus(control: HTMLElement) {
  if (
    control.matches(':disabled, input[type="hidden"]') ||
    control.closest(
      '[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]',
    )
  )
    return false;
  const view = control.ownerDocument.defaultView;
  if (!view) return false;
  for (
    let node: HTMLElement | null = control;
    node;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (
      style.display === "none" ||
      ["hidden", "collapse"].includes(style.visibility) ||
      style.contentVisibility === "hidden" ||
      style.opacity === "0"
    )
      return false;
  }
  return true;
}

export type AppFormSubmitHandle = { submit: () => void };

/** rc-field-form owns validation; focus recovery is explicitly task-owned. */
export function AppForm<Values = Record<string, unknown>>({
  disabled = false,
  className,
  children,
  submitErrorFocusOwner,
  submitWithErrorFocusRef,
  onSubmitCapture,
  onFinish,
  onFinishFailed,
  ...props
}: FormProps<Values> & {
  disabled?: boolean;
  /** Explicit recovery ownership, invalidated when the editing task changes. */
  submitErrorFocusOwner?: object | null;
  /** Guarded actions may opt into the same recovery without native submission. */
  submitWithErrorFocusRef?: Ref<AppFormSubmitHandle>;
}) {
  const formRef = useRef<
    FormInstance<Values> & { nativeElement?: HTMLElement }
  >(null);
  const submission = useRef<SubmitFocus | null>(null);
  const [recovery, setRecovery] = useState<SubmitFocus | null>(null);
  const cancelRecovery = () => {
    submission.current?.release();
    submission.current = null;
  };
  const beginRecovery = (form: HTMLFormElement) => {
    cancelRecovery();
    if (!submitErrorFocusOwner || onFinishFailed || disabled) return;
    const doc = form.ownerDocument;
    // These listeners start after the initiating key/click. Even moving
    // away and back is newer intent, not permission to reclaim focus.
    const events = ["focusin", "pointerdown", "keydown", "input"] as const;
    const cancel = () => cancelRecovery();
    for (const name of events) doc.addEventListener(name, cancel, true);
    doc.defaultView?.addEventListener("blur", cancel);
    submission.current = {
      form,
      origin: doc.activeElement,
      owner: submitErrorFocusOwner,
      release: () => {
        for (const name of events) doc.removeEventListener(name, cancel, true);
        doc.defaultView?.removeEventListener("blur", cancel);
      },
    };
  };
  useImperativeHandle(submitWithErrorFocusRef, () => ({
    submit: () => {
      cancelRecovery();
      const form = formRef.current;
      if (form?.nativeElement instanceof HTMLFormElement)
        beginRecovery(form.nativeElement);
      form?.submit();
    },
  }));
  useLayoutEffect(() => {
    cancelRecovery();
    return cancelRecovery;
  }, [submitErrorFocusOwner]);
  useLayoutEffect(() => {
    if (!recovery || submission.current !== recovery) return;
    const { form, origin, owner } = recovery;
    const eligible =
      owner === submitErrorFocusOwner &&
      form.isConnected &&
      form.ownerDocument.activeElement === origin &&
      !disabled &&
      !onFinishFailed;
    cancelRecovery();
    if (!eligible) return;
    // Wait for the error DOM commit, then use the actual native control. Focusing
    // enters the existing modal reveal path; never open collapsed content here.
    const controls = form.querySelectorAll<HTMLElement>(
      'input[aria-invalid="true"], button[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"]',
    );
    for (const control of controls) {
      if (!canRecoverFocus(control)) continue;
      control.focus();
      if (form.ownerDocument.activeElement === control) break;
    }
  }, [recovery, submitErrorFocusOwner, disabled, onFinishFailed]);
  return (
    <DisabledContext.Provider value={disabled}>
      <RcForm<Values>
        ref={formRef}
        className={cn("space-y-5", className)}
        validateMessages={{ required: "请填写${label}" }}
        {...props}
        onSubmitCapture={(event) => {
          cancelRecovery();
          onSubmitCapture?.(event);
          if (
            !submitErrorFocusOwner ||
            onFinishFailed ||
            disabled ||
            event.defaultPrevented ||
            !(event.currentTarget instanceof HTMLFormElement)
          )
            return;
          beginRecovery(event.currentTarget);
        }}
        onFinish={(values) => {
          cancelRecovery();
          onFinish?.(values);
        }}
        onFinishFailed={(error) => {
          if (onFinishFailed) {
            cancelRecovery();
            onFinishFailed(error);
          } else if (!error.outOfDate && submission.current) {
            setRecovery(submission.current);
          }
        }}
      >
        {children}
      </RcForm>
    </DisabledContext.Provider>
  );
}

export function useFormInstance<Values = Record<string, unknown>>() {
  return useContext(FieldContext) as FormInstance<Values>;
}

type ControlProps = {
  id?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};

export type AppFieldProps<Values = Record<string, unknown>> = Omit<
  FieldProps<Values>,
  "children"
> & {
  label?: ReactNode;
  description?: ReactNode;
  required?: boolean;
  hidden?: boolean;
  noStyle?: boolean;
  className?: string;
  children: ReactElement<ControlProps> | ((form: FormInstance<Values>) => ReactNode);
};

/** An explicit field seam. Controls retain their native shadcn event contracts. */
export function AppField<Values = Record<string, unknown>>({
  label,
  description,
  required,
  hidden,
  noStyle,
  className,
  children,
  onMetaChange,
  ...props
}: AppFieldProps<Values>) {
  const generatedId = useId();
  const disabled = useContext(DisabledContext);
  const [meta, setMeta] = useState<Pick<Meta, "errors" | "warnings">>({
    errors: [],
    warnings: [],
  });
  const isRequired = required ?? props.rules?.some(
    (rule) => typeof rule === "object" && rule.required,
  );
  const id = isValidElement(children) ? children.props.id || generatedId : generatedId;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const invalid = meta.errors.length > 0;
  const renderedChild = typeof children === "function"
    ? (_control: unknown, _meta: Meta, form: FormInstance<Values>) => children(form)
    : cloneElement(children, {
      id,
      disabled: disabled || children.props.disabled,
      "aria-invalid": invalid || undefined,
      "aria-required": isRequired || undefined,
      "aria-labelledby": children.props["aria-labelledby"] || (label != null ? `${id}-label` : undefined),
      "aria-describedby": [
        children.props["aria-describedby"],
        description ? descriptionId : undefined,
        invalid ? errorId : undefined,
      ].filter(Boolean).join(" ") || undefined,
    });
  const control = (
    <RcField<Values>
      {...props}
      validateTrigger={props.validateTrigger ?? props.trigger ?? "onChange"}
      messageVariables={{ ...(typeof label === "string" ? { label } : {}), ...props.messageVariables }}
      onMetaChange={(next) => {
        setMeta({ errors: next.errors, warnings: next.warnings });
        onMetaChange?.(next);
      }}
    >
      {renderedChild}
    </RcField>
  );
  if (noStyle) return control;
  return (
    <Field hidden={hidden} className={className} data-invalid={invalid || undefined}>
      {label != null && <FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel>}
      <div className="min-w-0">{control}</div>
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      {invalid && <FieldError id={errorId} errors={meta.errors.map((message) => ({ message }))} />}
    </Field>
  );
}

export { FormList, useForm, useWatch };
export type { FormInstance, FormProps };
