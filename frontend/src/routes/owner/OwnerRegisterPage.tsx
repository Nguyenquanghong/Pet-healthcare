import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Eye, EyeOff, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";
import { useAppStore } from "../../store/AppStoreProvider";
import { AuthShell } from "../auth/AuthShell";

type RegisterFormErrors = Partial<Record<"email" | "password" | "confirmPassword" | "form", string>>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OwnerRegisterPage() {
  const navigate = useNavigate();
  const { owners, registerOwner } = useAppStore();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [address, setAddress] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const [created, setCreated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const existingEmails = useMemo(
    () => new Set(owners.map((owner) => owner.email?.trim().toLowerCase()).filter(Boolean)),
    [owners],
  );

  const validate = () => {
    const nextErrors: RegisterFormErrors = {};
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) nextErrors.email = "Email is required.";
    else if (!emailPattern.test(normalizedEmail)) nextErrors.email = "Enter a valid email address.";
    else if (existingEmails.has(normalizedEmail)) nextErrors.email = "An account with this email already exists.";

    if (!password) nextErrors.password = "Password is required.";
    else if (password.length < 8 || password.length > 128) nextErrors.password = "Password must contain 8 to 128 characters.";
    if (!confirmPassword) nextErrors.confirmPassword = "Confirm password is required.";
    else if (password && confirmPassword !== password) nextErrors.confirmPassword = "Confirm password must match the password.";

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      await registerOwner({
        fullName: fullName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim().toLowerCase(),
        password,
        confirmPassword,
        address: address.trim() || undefined,
      });

      setCreated(true);
      window.setTimeout(() => navigate("/owner/pets", { replace: true }), 900);
    } catch (reason) {
      setErrors({ form: reason instanceof Error ? reason.message : "We could not create your account. Please try again." });
      setIsSubmitting(false);
    }
  };

  const clearErrors = () => setErrors({});

  return (
    <AuthShell
      eyebrow="Owner Portal"
      title="Create Your Owner Account"
      description="Register to manage pets, book appointments, review medical records, receive notifications, and use pet hotel services."
    >
      <section>
        <div className="mb-6">
          <p className="text-sm font-semibold text-primary">Register</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Owner Details</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">Fields marked with * are required. You will be signed in after your account is created.</p>
        </div>

        {created && (
          <div className="mb-5 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-800">
            <CheckCircle2 size={16} /> Account created successfully. Redirecting to add your pet profile...
          </div>
        )}
        {errors.form && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-medium text-rose-700">{errors.form}</div>}

        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <Input
            label="Full name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Example: Alex Nguyen"
            autoComplete="name"
            disabled={isSubmitting}
          />
          <Input
            label="Phone number"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="Example: 0901234567"
            autoComplete="tel"
            disabled={isSubmitting}
          />
          <Input
            type="email"
            label="Email *"
            value={email}
            error={errors.email}
            onChange={(event) => {
              setEmail(event.target.value);
              clearErrors();
            }}
            placeholder="owner@example.com"
            autoComplete="email"
            disabled={isSubmitting}
          />
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              label="Password *"
              value={password}
              error={errors.password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearErrors();
              }}
              placeholder="Create a password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              disabled={isSubmitting}
              className="[&_input]:pr-12"
            />
            <button
              type="button"
              className="absolute right-3 top-9 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              disabled={isSubmitting}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <div className="relative">
            <Input
              type={showConfirmPassword ? "text" : "password"}
              label="Confirm password *"
              value={confirmPassword}
              error={errors.confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                clearErrors();
              }}
              placeholder="Re-enter your password"
              maxLength={128}
              autoComplete="new-password"
              disabled={isSubmitting}
              className="[&_input]:pr-12"
            />
            <button
              type="button"
              className="absolute right-3 top-9 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setShowConfirmPassword((value) => !value)}
              aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
              disabled={isSubmitting}
            >
              {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <Textarea
            label="Address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Ward, district, city..."
            rows={3}
            disabled={isSubmitting}
          />
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
            <Button type="submit" size="lg" icon={<UserPlus size={18} />} className="w-full sm:w-auto" disabled={isSubmitting || created}>
              {isSubmitting ? "Creating account..." : "Create owner account"}
            </Button>
            <Link to="/" className="text-center text-sm font-semibold text-slate-500 transition hover:text-primary">
              Back to portal selection
            </Link>
          </div>
        </form>
      </section>
    </AuthShell>
  );
}
