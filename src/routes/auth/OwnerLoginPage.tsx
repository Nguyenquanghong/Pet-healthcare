import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useAppStore } from "../../store/AppStoreProvider";
import { AuthShell } from "./AuthShell";

type LoginFormErrors = Partial<Record<"email" | "password" | "form", string>>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OwnerLoginPage() {
  const navigate = useNavigate();
  const { loginOwner } = useAppStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<LoginFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validate = () => {
    const nextErrors: LoginFormErrors = {};
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) nextErrors.email = "Email is required.";
    else if (!emailPattern.test(normalizedEmail)) nextErrors.email = "Enter a valid email address.";
    if (!password) nextErrors.password = "Password is required.";

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    const success = await loginOwner(email, password);
    setIsSubmitting(false);

    if (!success) {
      setErrors({ form: "The email or password is incorrect." });
      return;
    }
    navigate("/owner/dashboard", { replace: true });
  };

  return (
    <AuthShell
      eyebrow="Owner Portal"
      title="Welcome Back"
      description="Sign in to view appointments, medical records, notifications, and services for your pets."
    >
      <section>
        <div className="mb-6">
          <p className="text-sm font-semibold text-primary">Sign in</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Owner Portal</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Demo: use <span className="font-bold text-slate-700">owner@example.com</span> /{" "}
            <span className="font-bold text-slate-700">owner123</span>.
          </p>
        </div>
        {errors.form && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-medium text-rose-700">{errors.form}</div>}
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <Input
            type="email"
            label="Email *"
            value={email}
            error={errors.email}
            onChange={(event) => {
              setEmail(event.target.value);
              setErrors({});
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
                setErrors({});
              }}
              placeholder="Enter your password"
              autoComplete="current-password"
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
          <Button type="submit" size="lg" className="w-full" icon={<LockKeyhole size={18} />} disabled={isSubmitting}>
            {isSubmitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
        <div className="mt-6 flex flex-col gap-3 text-sm font-semibold sm:flex-row sm:justify-between">
          <Link to="/register" className="text-primary hover:underline">
            Create an account
          </Link>
          <Link to="/" className="text-slate-500 hover:text-primary">
            Back to portal selection
          </Link>
        </div>
      </section>
    </AuthShell>
  );
}
