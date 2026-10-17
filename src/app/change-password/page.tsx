import Link from "next/link";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { requireUser } from "@/server/dal";

/** S-02: mandatory after signing in with a temporary password (SEC-05). */
export default async function ChangePasswordPage() {
  const user = await requireUser({ allowPendingPasswordChange: true });
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-bold">{t.changePassword.title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {user.mustChangePassword && (
            <Alert>
              <AlertDescription>{t.changePassword.requiredHint}</AlertDescription>
            </Alert>
          )}
          <ChangePasswordForm />
          {!user.mustChangePassword && (
            <Link href="/" className="text-center text-sm text-muted-foreground underline">
              {t.forbidden.back}
            </Link>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
