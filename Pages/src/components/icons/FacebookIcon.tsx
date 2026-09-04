export const FacebookIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...props}>
    <path
      fill="currentColor"
      d="M24 12c0-6.627-5.373-12-12-12S0 5.373 0 12c0 5.64 3.876 10.355 9.103 11.652V15.69H6.356V12h2.747V9.338c0-4.08 1.85-5.978 5.858-5.978.76 0 2.072.149 2.609.298v3.325c-.284-.03-.775-.045-1.387-.045-1.968 0-2.728.746-2.728 2.684V12h3.92l-.673 3.689h-3.247v7.963C20.124 22.355 24 17.64 24 12Z"
    />
  </svg>
);
