import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export default function ProfileAvatar({
  photoUrl,
  fallback,
  className,
}: {
  photoUrl?: string | null;
  fallback: string;
  className?: string;
}) {
  const [busted, setBusted] = useState(false);
  useEffect(() => { setBusted(false); }, [photoUrl]);

  return (
    <Avatar className={cn("border border-border", className)}>
      {photoUrl && !busted ? <AvatarImage src={photoUrl} alt="" loading="lazy" decoding="async" onError={() => setBusted(true)} /> : null}
      <AvatarFallback>{fallback}</AvatarFallback>
    </Avatar>
  );
}
