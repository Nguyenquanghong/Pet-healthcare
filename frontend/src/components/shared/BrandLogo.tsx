import logoMark from "../../assets/nipopeto-mark.png";
import logoLockup from "../../assets/nipopeto-logo-cropped.png";

interface BrandLogoProps {
  variant?: "mark" | "lockup";
  className?: string;
}

export function BrandLogo({ variant = "mark", className = "" }: BrandLogoProps) {
  const src = variant === "lockup" ? logoLockup : logoMark;

  return <img src={src} alt="NIPOPETO Nippon Pet Care" className={`object-contain ${className}`} />;
}
