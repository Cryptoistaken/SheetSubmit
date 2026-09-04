import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAvatarUrl } from "@/lib/avatarCache";
import { cn } from "@/lib/utils";

export default function ProfileAvatar({
  userId,
  photoUrl,
  fallback,
  className,
}: {
  userId?: string;
  photoUrl?: string | null;
  fallback: string;
  className?: string;
}) {
  const src = useAvatarUrl(userId, photoUrl);

  return (
    <Avatar className={cn("border border-border", className)}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>{fallback}</AvatarFallback>
    </Avatar>
  );
}
