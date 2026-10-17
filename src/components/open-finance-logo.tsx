import type { SVGProps } from 'react'

/**
 * Official Open Finance Brasil symbol (`simbolo_open_finance.HTML.svg` from
 * openfinancebrasil.org.br/manual-de-identidade), paths unchanged. It is filled
 * with `currentColor` so it follows the navigation's text and active states;
 * the viewBox pads the symbol like Lucide's 24px grid. The outline variant's
 * double contours blur at icon sizes, so the solid one is used here.
 */
export function OpenFinanceLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="198 198 404 404"
      width={24}
      height={24}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M548.28,343.77c-14.25-24.74-34.07-44.33-59.47-58.76c-22.36-12.7-46.06-19.81-71.09-21.33v72.33c20.36,1.81,37.39,9.88,51.09,24.21c15.67,16.4,23.52,37.72,23.52,63.96c0,26.25-7.98,47.7-23.94,64.38c-15.96,16.69-35.96,25.02-59.99,25.02c-21.98,0-40.46-6.92-55.45-20.72l-51.31,51.31C331.4,571.39,366.75,585,407.7,585c29.81,0,57.08-7.07,81.82-21.22c24.98-14.29,44.67-34.17,59.04-59.65c13.58-24.06,20.88-51.39,21.07-79.02C569.84,395.98,562.72,368.86,548.28,343.77z" />
      <path d="M351.76,357.87c13.24-12.74,29.12-20.01,47.63-21.8V215c-47.21,3.46-92.04,26.16-123.48,67.03L351.76,357.87z" />
      <path d="M325.57,416.8c1.06-17.12,5.84-32.07,14.36-44.83l-77.08-77.08c-26.69,37.27-36.3,84.78-31.18,121.9H325.57z" />
      <path d="M325.81,435.13h-94.13c7.19,42.85,31.23,74.79,57.09,95.99l52.08-52.08C332.3,466.69,327.3,452.05,325.81,435.13z" />
    </svg>
  )
}
