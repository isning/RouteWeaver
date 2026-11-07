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
export function SecuritySettings() {
    const { snapshot } = useSessionAccess();
    return <MFASetupTask key={`${snapshot.accountEpoch}:${snapshot.generation}`} />;
}
function MFASetupTask() {
    const { lifecycle, snapshot } = useSessionAccess();
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
                const value = await post<{ secret: string; uri: string }>("/auth/mfa/setup", values);
                if (typeof value?.secret !== "string" || !value.secret.trim() ||
                    typeof value?.uri !== "string" || !value.uri.trim()) {
                    throw new Error("未收到完整的验证器设置，请重新设置二次验证。");
                }
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
                    const value = await post<Session>("/auth/mfa/enable", values);
                    if (typeof value?.user?.id !== "string" || !value.user.id ||
                        value.user.id !== snapshot.session?.user.id ||
                        value?.user?.role !== "admin" || value?.user?.mfaEnabled !== true ||
                        typeof value?.csrfToken !== "string" || !value.csrfToken.trim()) {
                        throw new Error("Incomplete MFA enable response");
                    }
                } catch (error) {
                    // A lost or malformed response can follow a committed enrollment
                    // and rotated cookie. Recheck authority without replaying the write.
                    if (!(error instanceof APIError && [400, 401, 403, 429].includes(error.status))) {
                        if (active.current) {
                            uncertainEnable.current = true;
                            setEnableUncertain(true);
                            codeForm.resetFields();
                        }
                        lifecycle.changed();
                        void lifecycle.check();
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
            // The cookie may have rotated even after this screen was removed.
            // Reconcile current authority, but never resurrect the old task UI.
            lifecycle.changed();
            void lifecycle.check();
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
      <QueryState loading={session.isLoading} error={session.error} retry={() => session.refetch()}>
        {session.data?.user.mfaEnabled === true ? (<div className="security-enabled flex flex-wrap items-center gap-3 rounded-lg border p-4">
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
            <p className="mt-4 text-sm text-muted-foreground">关闭只清除此页的设置密钥和输入，不会撤销已提交的启用操作。</p>
            <AppForm disabled={enable.isPending || enableUncertain} form={codeForm} className="mt-6 max-w-sm" onFinish={(v) => {
                if (!active.current || submitting.current || uncertainEnable.current) return;
                submitting.current = true;
                enable.mutate({ code: v.code });
            }}>
              <ErrorNotice error={enable.error}/>
              <AppField name="code" label="验证器验证码" rules={[
                { required: true },
                { pattern: /^\d{6}$/, message: "请输入六位数字验证码" },
            ]}>
                <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6}/>
              </AppField>
              <ActionButton type="submit" pending={enable.isPending} disabled={enableUncertain} variant="default">
                验证并启用
              </ActionButton>
              <ActionButton disabled={enable.isPending} onClick={dismissSetup} variant="ghost">
                关闭设置
              </ActionButton>
            </AppForm>
          </>) : (<AppForm disabled={prepare.isPending} form={passwordForm} className="settings-form max-w-md space-y-5" onFinish={(v) => {
            if (!active.current || submitting.current) return;
            submitting.current = true;
            prepare.mutate({ password: v.password });
        }}>
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
