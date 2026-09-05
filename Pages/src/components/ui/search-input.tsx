import type { CSSProperties, InputHTMLAttributes } from "react";

import { SearchIcon } from "@/components/icons/FileTypeIcons";
import { cn } from "@/lib/utils";

type SearchInputProps = InputHTMLAttributes<HTMLInputElement> & {
  containerClassName?: string;
  containerStyle?: CSSProperties;
};

export default function SearchInput({ className, containerClassName, containerStyle, ...props }: SearchInputProps) {
  return (
    <label className={cn("search-input-shell", containerClassName)} style={containerStyle}>
      <span className="search-input-group">
        <span className="search-input-icon"><SearchIcon size={16} /></span>
        <input {...props} type="search" className={cn("search-input", className)} />
      </span>
    </label>
  );
}
