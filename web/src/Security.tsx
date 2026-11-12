import { SecurityRecoveryNotice, useSecurityRecovery } from "./SecurityRecovery";
import { PasswordInput } from "@/ui-patterns/password-input";
import { QRCodeSVG as QRCode } from "qrcode.react";
import { ActionButton } from "@/ui-patterns/actions";
import { Input } from "@/components/ui/input";
import { Notice } from "@/ui-patterns/notice";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { ShieldCheck as SafetyCertificateOutlined } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { APIError, post } from "./api";
import type { Session } from "./types";
import { useSessionAccess } from "./SessionBoundary";
import { ErrorNotice, QueryState, Section } from "./components";
function enrollmentError(error: Error | null) {
    if (!(error instanceof APIError)) return error;
    const messages: Record<string, string> = {
        "400:invalid credentials": "当前账号或密码未通过验证，请核对后重试。",
        "400:MFA already enabled": "此账号已启用二次验证，请刷新页面核对当前状态。",
        "400:MFA enrollment expired, already completed, or invalid code": "设置可能已过期、已完成，或验证码不正确。请核对验证码；仍无法启用时，刷新页面确认状态后再决定是否重新设置。",
        "403:local administrator session required": "请使用管理员账号密码登录后设置二次验证。",
        "429:too many MFA attempts; retry later": "二次验证尝试次数过多，请稍后再试。",
    };
    const message = messages[`${error.status}:${error.message}`];
    return message ? new Error(message) : error;
}
export function SecuritySettings({ recoveryNotice = true }: { recoveryNotice?: boolean }) {
    const { snapshot } = useSessionAccess();
    return <MFASetupTask key={`${snapshot.accountEpoch}:${snapshot.generation}`} recoveryNotice={recoveryNotice} />;
}
function MFASetupTask({ recoveryNotice }: { recoveryNotice: boolean }) {
    const { lifecycle, snapshot } = useSessionAccess();
    const recovery = useSecurityRecovery(snapshot.session?.user.id ?? "");
    const active = useRef(true);
    const submitting = useRef(false);
    useLayoutEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);
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
    const [enableUncertain, setEnableUncertain] = useState(false);
    const uncertainEnable = useRef(false);
    const [passwordForm] = useForm();
    const [codeForm] = useForm();
    const prepare = useMutation({
        // Return no setup material to the mutation cache. It belongs only to
        // this mounted enrollment task, not a settled mutation result.
        mutationFn: async (values: { password: string }) => {
            try {
                if (!active.current) throw new Error("设置页面已关闭，本次尚未提交。");
                const value = await recovery.run("mfa-setup", snapshot.session!.user.id,
                    () => post<{ secret: string; uri: string }>("/auth/mfa/setup", values),
                    (value) => typeof value?.secret === "string" && Boolean(value.secret.trim()) &&
                        typeof value?.uri === "string" && Boolean(value.uri.trim()),
                    "未收到完整的验证器设置。请先查看当前状态，再决定是否重新设置。");
                if (active.current) {
                    setSetup({ secret: value.secret, uri: value.uri });
                    passwordForm.resetFields();
                }
            } finally {
                values.password = "";
            }
        },
        retry: false,
        networkMode: "always",
        gcTime: 0,
        onSettled: () => { submitting.current = false; },
    });
    const enable = useMutation({
        mutationFn: async (values: { code: string }) => {
            try {
                if (!active.current) throw new Error("设置页面已关闭，本次尚未提交。");
                try {
                    await recovery.run("mfa-enable", snapshot.session!.user.id,
                        () => post<Session>("/auth/mfa/enable", values),
                        (value) => typeof value?.user?.id === "string" && Boolean(value.user.id) &&
                            value.user.id === snapshot.session?.user.id &&
                            value.user.role === "admin" && value.user.mfaEnabled === true &&
                            typeof value.csrfToken === "string" && Boolean(value.csrfToken.trim()),
                        "启用结果尚未确认。请先核对当前登录状态，不要重复提交。");
                } catch (error) {
                    // A lost or malformed response can follow a committed enrollment
                    // and rotated cookie. Recheck authority without replaying the write.
                    if (recovery.hasRecord() && !(error instanceof APIError && [400, 401, 403, 429].includes(error.status))) {
                        if (active.current) {
                            uncertainEnable.current = true;
                            setEnableUncertain(true);
                            codeForm.resetFields();
                        }
                        throw new Error("启用结果尚未确认。请先核对当前登录状态，不要重复提交。");
                    }
                    throw error;
                }
            } finally {
                values.code = "";
            }
        },
        retry: false,
        networkMode: "always",
        gcTime: 0,
        onSuccess: () => {
            // The shared owner reconciles even after this screen is removed.
            if (!active.current) return;
            setSetup(null);
            codeForm.resetFields();
            prepare.reset();
            // Only the reconciled session below may show enrollment as enabled.
        },
        onSettled: () => { submitting.current = false; },
    });
    const dismissSetup = () => {
        if (!active.current || submitting.current) return;
        setSetup(null);
        codeForm.resetFields();
        passwordForm.resetFields();
        prepare.reset();
        enable.reset();
        uncertainEnable.current = false;
        setEnableUncertain(false);
    };
    return (<Section title="管理员二次验证" description="保护当前登录账号：登录时在密码之外验证一次性验证码。">
      {recoveryNotice && <SecurityRecoveryNotice recovery={recovery} />}
      <QueryState loading={session.isLoading} error={session.error} retry={() => session.refetch()}>
        {session.data?.user.mfaEnabled === true ? (<div className="security-enabled flex flex-wrap items-center gap-3 rounded-lg border p-4">
            <SafetyCertificateOutlined aria-hidden="true"/>
            <div>
              <h3 className="text-sm font-medium">二次验证已启用</h3>
              <p className="mt-1 text-sm text-muted-foreground">下次登录需要输入验证器中的六位验证码。</p>
            </div>
          </div>) : setup ? (<>
            <Notice tone="info" title="使用验证器扫描二维码">本次设置需在生成后 10 分钟内完成。完成下方验证后才会启用；请妥善保存验证器的安全备份。</Notice>
            <div className="qr-container my-5 grid w-fit justify-items-start gap-3 rounded-lg border bg-white p-4 text-black">
              <QRCode value={setup.uri} size={190}/>
            </div>
            <details className="space-y-3 rounded-lg border p-4">
              <summary className="muted text-sm text-muted-foreground">无法扫码？手动输入密钥</summary>
              <PasswordInput aria-label="验证器设置密钥" revealLabel="验证器设置密钥" value={setup.secret} readOnly autoComplete="off" className="mt-3"/>
            </details>
            <p className="mt-4 text-sm text-muted-foreground">关闭只清除此页的设置密钥和输入，不会撤销已提交的启用操作。</p>
            <AppForm disabled={enable.isPending || enableUncertain || recovery.blocked} form={codeForm} className="mt-6 max-w-sm" onFinish={(v) => {
                if (!active.current || submitting.current || uncertainEnable.current || recovery.blocked) return;
                submitting.current = true;
                enable.mutate({ code: v.code });
            }}>
              <ErrorNotice error={enrollmentError(enable.error)}/>
              <AppField name="code" label="验证器验证码" rules={[
                { required: true },
                { pattern: /^\d{6}$/, message: "请输入六位数字验证码" },
            ]}>
                <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6}/>
              </AppField>
              <p className="text-sm text-muted-foreground">启用后将更新当前登录状态，并退出其他登录会话。</p>
              <ActionButton type="submit" pending={enable.isPending} disabled={enableUncertain || recovery.blocked} variant="default">
                验证并启用
              </ActionButton>
              <ActionButton disabled={enable.isPending} onClick={dismissSetup} variant="ghost">
                关闭设置
              </ActionButton>
            </AppForm>
          </>) : (<AppForm disabled={prepare.isPending || recovery.blocked} form={passwordForm} className="settings-form max-w-md space-y-5" onFinish={(v) => {
            if (!active.current || submitting.current || recovery.blocked) return;
            submitting.current = true;
            prepare.mutate({ password: v.password });
        }}>
            <ErrorNotice error={enrollmentError(prepare.error)}/>
            <AppField name="password" label="验证当前账号密码" rules={[{ required: true }]}>
              <PasswordInput autoComplete="current-password" revealLabel="二次验证设置的验证密码"/>
            </AppField>
            <ActionButton type="submit" pending={prepare.isPending} disabled={recovery.blocked} variant="default">
              设置二次验证
            </ActionButton>
          </AppForm>)}
      </QueryState>
    </Section>);
}
