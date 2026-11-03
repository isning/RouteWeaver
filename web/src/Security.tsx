import { PasswordInput } from "@/ui-patterns/password-input";
import { QRCodeSVG as QRCode } from "qrcode.react";
import { ActionButton } from "@/ui-patterns/actions";
import { Input } from "@/components/ui/input";
import { Notice } from "@/ui-patterns/notice";
import { toast } from "sonner";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { ShieldCheck as SafetyCertificateOutlined } from "lucide-react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "./api";
import { useSessionAccess } from "./SessionBoundary";
import { ErrorNotice, QueryState, Section } from "./components";
export function SecuritySettings() {
    const { lifecycle, snapshot } = useSessionAccess();
    const session = {
        data: snapshot.session,
        isLoading: snapshot.phase === "checking",
        error: snapshot.error,
        refetch: lifecycle.check,
    };
    const [setup, setSetup] = useState<{
        secret: string;
        uri: string;
    } | null>(null);
    const [passwordForm] = useForm();
    const [codeForm] = useForm();
    const message = toast;
    const prepare = useMutation({
        mutationFn: (values: {
            password: string;
        }) => post<{
            secret: string;
            uri: string;
        }>("/auth/mfa/setup", values),
        onSuccess: (value) => {
            setSetup(value);
            passwordForm.resetFields();
        },
    });
    const enable = useMutation({
        mutationFn: (values: {
            code: string;
        }) => post("/auth/mfa/enable", values),
        onSuccess: () => {
            setSetup(null);
            codeForm.resetFields();
            lifecycle.changed();
            void lifecycle.check();
            message.success("二次验证已启用");
        },
    });
    return (<Section title="管理员二次验证" className="max-w-3xl" description="在密码之外，使用验证器应用的一次性验证码保护管理账号。">
      <QueryState loading={session.isLoading} error={session.error} retry={() => session.refetch()}>
        {session.data?.user.mfaEnabled ? (<div className="security-enabled flex flex-wrap items-center gap-3 rounded-lg border p-4">
            <SafetyCertificateOutlined aria-hidden="true"/>
            <div>
              <h3 className="text-sm font-medium">二次验证已启用</h3>
              <p className="mt-1 text-sm text-muted-foreground">下次登录需要输入验证器中的六位验证码。</p>
            </div>
          </div>) : setup ? (<>
            <Notice tone="info" title="使用验证器扫描二维码">{"\u5B8C\u6210\u4E0B\u65B9\u9A8C\u8BC1\u540E\u624D\u4F1A\u542F\u7528\u3002\u8BF7\u59A5\u5584\u4FDD\u5B58\u9A8C\u8BC1\u5668\u7684\u5B89\u5168\u5907\u4EFD\u3002"}</Notice>
            <div className="qr-container my-5 grid w-fit justify-items-start gap-3 rounded-lg border bg-white p-4 text-black">
              <QRCode value={setup.uri} size={190}/>
            </div>
            <details className="space-y-3 rounded-lg border p-4">
              <summary className="muted text-sm text-muted-foreground">无法扫码？手动输入密钥</summary>
              <PasswordInput aria-label="验证器设置密钥" revealLabel="验证器设置密钥" value={setup.secret} readOnly autoComplete="off" className="mt-3"/>
            </details>
            <AppForm disabled={enable.isPending} form={codeForm} className="mt-6 max-w-sm" onFinish={(v) => enable.mutate(v)}>
              <ErrorNotice error={enable.error}/>
              <AppField name="code" label="验证器验证码" rules={[
                { required: true },
                { pattern: /^\d{6}$/, message: "请输入六位数字验证码" },
            ]}>
                <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6}/>
              </AppField>
              <ActionButton type="submit" pending={enable.isPending} variant="default">
                验证并启用
              </ActionButton>
              <ActionButton disabled={enable.isPending} onClick={() => {
                setSetup(null);
                codeForm.resetFields();
            }} variant="ghost">
                取消
              </ActionButton>
            </AppForm>
          </>) : (<AppForm disabled={prepare.isPending} form={passwordForm} className="settings-form max-w-md space-y-5" onFinish={(v) => prepare.mutate(v)}>
            <ErrorNotice error={prepare.error}/>
            <AppField name="password" label="验证当前账号密码" rules={[{ required: true }]}>
              <PasswordInput autoComplete="current-password"/>
            </AppField>
            <ActionButton type="submit" pending={prepare.isPending} variant="default">
              设置二次验证
            </ActionButton>
          </AppForm>)}
      </QueryState>
    </Section>);
}
