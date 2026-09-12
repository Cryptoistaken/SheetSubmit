import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { VerifiedIcon } from "@/components/icons/FileTypeIcons";
import { cn } from "@/lib/utils";

export default function ProfileAvatar({
  photoUrl,
  fallback,
  className,
  verified,
  badgeSize = 18,
}: {
  photoUrl?: string | null;
  fallback: string;
  className?: string;
  verified?: boolean;
  badgeSize?: number;
}) {
  const [busted, setBusted] = useState(false);
  useEffect(() => { setBusted(false); }, [photoUrl]);

  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <Avatar className={cn("border border-border", className)}>
        {photoUrl && !busted ? <AvatarImage src={photoUrl} alt="" loading="lazy" decoding="async" onError={() => setBusted(true)} /> : null}
        <AvatarFallback>{fallback}</AvatarFallback>
      </Avatar>
      {verified ? (
        <span title="Verified" style={{ position: "absolute", right: -4, bottom: -4, width: badgeSize, height: badgeSize, display: "grid", placeItems: "center", color: "var(--text)", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.15))" }}>
          <VerifiedIcon size={badgeSize} />
        </span>
      ) : null}
    </span>
  );
}
