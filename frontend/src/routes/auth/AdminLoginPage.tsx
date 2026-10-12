import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useSession } from "../../store/SessionContext";
import { AuthShell } from "./AuthShell";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const { loginAdmin, status, error: sessionError } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "checking" || isSubmitting) return;
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setIsSubmitting(true);
    const loginError = await loginAdmin(username, password);
    setIsSubmitting(false);

    if (loginError) {
      setError(loginError);
      return;
    }
    navigate("/admin/dashboard", { replace: true });
  };

  return (
    <AuthShell
      eyebrow="Admin Portal"
      title="Secure Admin Access"
      description="A private portal for doctors and operations staff to manage appointments, pet records, notifications, and hospital activity."
      tone="admin"
    >
      <section>
        <div className="mb-6">
          <p className="text-sm font-semibold text-primary">Internal access</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Admin Sign In</h1>
        </div>
        {(error || sessionError) && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-medium text-rose-700">{error || sessionError}</div>}
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <Input
            label="Username *"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setError("");
            }}
            autoComplete="username"
            disabled={isSubmitting || status === "checking"}
          />
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              label="Password *"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              autoComplete="current-password"
              className="[&_input]:pr-12"
              disabled={isSubmitting || status === "checking"}
            />
            <button
              type="button"
              className="absolute right-3 top-9 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              disabled={isSubmitting || status === "checking"}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <Button type="submit" size="lg" className="w-full" icon={<LockKeyhole size={18} />} disabled={isSubmitting || status === "checking"}>
            {isSubmitting || status === "checking" ? "Signing in..." : "Sign in as admin"}
          </Button>
        </form>
        <Link to="/" className="mt-5 block text-center text-sm font-semibold text-slate-500 hover:text-primary">
          Back to portal selection
        </Link>
      </section>
    </AuthShell>
  );
}
