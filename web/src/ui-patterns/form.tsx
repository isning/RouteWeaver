import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
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

/** State and validation belong to rc-field-form; this adds only field layout. */
export function AppForm<Values = Record<string, unknown>>({
  disabled = false,
  className,
  children,
  ...props
}: FormProps<Values> & { disabled?: boolean }) {
  return (
    <DisabledContext.Provider value={disabled}>
      <RcForm<Values>
        className={cn("space-y-5", className)}
        validateMessages={{ required: "请填写${label}" }}
        {...props}
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
