import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { useAppStore } from "../../store/AppStoreProvider";
import { AuthShell } from "./AuthShell";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const { loginAdmin } = useAppStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setIsSubmitting(true);
    const success = await loginAdmin(username, password);
    setIsSubmitting(false);

    if (!success) {
      setError("The admin username or password is incorrect.");
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
      <Card className="border-slate-800 bg-slate-900 p-6 text-white shadow-[0_24px_70px_rgba(0,0,0,0.28)] lg:p-8">
        <div className="mb-6">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-aqua text-primary">
            <ShieldCheck />
          </div>
          <p className="text-sm font-extrabold uppercase tracking-[0.22em] text-aqua">Internal security</p>
          <h1 className="mt-2 text-3xl font-black">Admin Sign In</h1>
          <p className="mt-2 text-sm text-slate-400">
            Demo: <span className="font-bold text-white">admin</span> / <span className="font-bold text-white">admin123</span>.
          </p>
        </div>
        {error && <div className="mb-4 rounded-xl bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-300">{error}</div>}
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <Input
            label="Username *"
            labelClassName="text-slate-200"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setError("");
            }}
            placeholder="admin"
            autoComplete="username"
            disabled={isSubmitting}
          />
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              label="Password *"
              labelClassName="text-slate-200"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              placeholder="admin123"
              autoComplete="current-password"
              className="[&_input]:pr-12"
              disabled={isSubmitting}
            />
            <button
              type="button"
              className="absolute right-3 top-9 rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              disabled={isSubmitting}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <Button type="submit" size="lg" className="w-full" icon={<LockKeyhole size={18} />} disabled={isSubmitting}>
            {isSubmitting ? "Signing in..." : "Sign in as admin"}
          </Button>
        </form>
        <Link to="/" className="mt-5 block text-center text-sm font-semibold text-slate-400 hover:text-white">
          Back to portal selection
        </Link>
      </Card>
    </AuthShell>
  );
}
