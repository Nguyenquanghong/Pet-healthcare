import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Save } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { useAppStore } from "../../store/AppStoreProvider";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ProfileForm = { fullName: string; email: string; phone: string; address: string };
type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string };

const emptyPasswordForm: PasswordForm = { currentPassword: "", newPassword: "", confirmPassword: "" };

export function OwnerProfilePage() {
  const { currentOwner, updateOwnerProfile, changePassword, isLoading } = useAppStore();
  const [profile, setProfile] = useState<ProfileForm>({ fullName: "", email: "", phone: "", address: "" });
  const [passwords, setPasswords] = useState<PasswordForm>(emptyPasswordForm);
  const [profileError, setProfileError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [profileSuccess, setProfileSuccess] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);

  useEffect(() => {
    setProfile({
      fullName: currentOwner.fullName || "",
      email: currentOwner.email || "",
      phone: currentOwner.phone || "",
      address: currentOwner.address || "",
    });
  }, [currentOwner.id, currentOwner.fullName, currentOwner.email, currentOwner.phone, currentOwner.address]);

  const initials = profile.fullName
    .split(" ")
    .filter(Boolean)
    .slice(-2)
    .map((word) => word[0])
    .join("")
    .toUpperCase() || "ON";

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault();
    setProfileError("");
    setProfileSuccess("");
    const fullName = profile.fullName.trim();
    const email = profile.email.trim().toLowerCase();
    if (!fullName) return setProfileError("Full name is required.");
    if (!email) return setProfileError("Email is required.");
    if (!emailPattern.test(email)) return setProfileError("Enter a valid email address.");

    try {
      const refreshed = await updateOwnerProfile({ ...profile, fullName, email, phone: profile.phone.trim(), address: profile.address.trim() });
      setProfileSuccess(refreshed ? "Profile updated successfully." : "Đã lưu hồ sơ nhưng chưa tải lại được dữ liệu. Hãy tải lại để đối chiếu.");
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : "Profile could not be updated.");
    }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");
    if (!passwords.currentPassword) return setPasswordError("Current password is required.");
    if (!passwords.newPassword) return setPasswordError("New password is required.");
    if (passwords.newPassword.length < 8 || passwords.newPassword.length > 128) return setPasswordError("New password must contain 8 to 128 characters.");
    if (passwords.newPassword !== passwords.confirmPassword) return setPasswordError("Confirm password must match the new password.");

    try {
      await changePassword(passwords);
      setPasswords(emptyPasswordForm);
      setPasswordSuccess("Password changed successfully.");
    } catch (reason) {
      setPasswordError(reason instanceof Error ? reason.message : "Password could not be changed.");
    }
  };

  return (
    <OwnerLayout title="Profile">
      <PageHeader title="Profile settings" description="Manage your contact information and account security." />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <Card title="Personal information">
          <div className="mb-6 flex items-center gap-4 border-b border-slate-200 pb-5">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-slate-100 text-base font-semibold text-primary">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-slate-950">{profile.fullName || "Owner account"}</p>
              <p className="truncate text-sm text-slate-500">{profile.email || "Add an email address"}</p>
            </div>
          </div>

          {profileError && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-medium text-rose-700">{profileError}</div>}
          {profileSuccess && <div role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700">{profileSuccess}</div>}

          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submitProfile} noValidate>
            <Input label="Full name *" value={profile.fullName} onChange={(event) => setProfile((value) => ({ ...value, fullName: event.target.value }))} autoComplete="name" disabled={isLoading} />
            <Input label="Email *" type="email" value={profile.email} onChange={(event) => setProfile((value) => ({ ...value, email: event.target.value }))} autoComplete="email" disabled={isLoading} />
            <Input label="Phone number" type="tel" value={profile.phone} onChange={(event) => setProfile((value) => ({ ...value, phone: event.target.value }))} autoComplete="tel" disabled={isLoading} />
            <Input label="Address" value={profile.address} onChange={(event) => setProfile((value) => ({ ...value, address: event.target.value }))} autoComplete="street-address" disabled={isLoading} />
            <div className="flex justify-end border-t border-slate-200 pt-4 sm:col-span-2">
              <Button type="submit" icon={<Save size={17} />} disabled={isLoading}>{isLoading ? "Saving..." : "Save changes"}</Button>
            </div>
          </form>
        </Card>

        <Card title="Password and security">
          <p className="mb-5 text-sm leading-6 text-slate-500">Use 8 to 128 characters and avoid reusing a password from another account.</p>
          {passwordError && <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-medium text-rose-700">{passwordError}</div>}
          {passwordSuccess && <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700">{passwordSuccess}</div>}

          <form className="space-y-4" onSubmit={submitPassword} noValidate>
            <Input label="Current password *" type={showPasswords ? "text" : "password"} value={passwords.currentPassword} onChange={(event) => setPasswords((value) => ({ ...value, currentPassword: event.target.value }))} autoComplete="current-password" disabled={isLoading} />
            <Input label="New password *" type={showPasswords ? "text" : "password"} value={passwords.newPassword} onChange={(event) => setPasswords((value) => ({ ...value, newPassword: event.target.value }))} autoComplete="new-password" disabled={isLoading} />
            <Input label="Confirm new password *" type={showPasswords ? "text" : "password"} value={passwords.confirmPassword} onChange={(event) => setPasswords((value) => ({ ...value, confirmPassword: event.target.value }))} autoComplete="new-password" disabled={isLoading} />
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600">
              <input type="checkbox" checked={showPasswords} onChange={(event) => setShowPasswords(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary" />
              {showPasswords ? <EyeOff size={16} /> : <Eye size={16} />}
              Show passwords
            </label>
            <div className="flex justify-end border-t border-slate-200 pt-4">
              <Button type="submit" disabled={isLoading}>{isLoading ? "Updating..." : "Change password"}</Button>
            </div>
          </form>
        </Card>
      </div>
    </OwnerLayout>
  );
}
