"use client";

import { useRouter } from "next/navigation";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { loginAction } from "@/server/actions/auth";

export function LoginForm() {
  const router = useRouter();
  const { run, pending, error } = useServerAction(loginAction);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run({ login: form.get("login"), password: form.get("password") }, (data) => {
      router.replace(data.mustChangePassword ? "/change-password" : "/");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormError error={error?.fieldErrors ? null : error} />
      <Field
        label={t.login.login}
        name="login"
        autoComplete="username"
        dir="ltr"
        className="text-start"
        required
        error={error?.fieldErrors?.login}
      />
      <Field
        label={t.login.password}
        name="password"
        type="password"
        autoComplete="current-password"
        dir="ltr"
        required
        error={error?.fieldErrors?.password}
      />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t.login.pending : t.login.submit}
      </Button>
    </form>
  );
}
