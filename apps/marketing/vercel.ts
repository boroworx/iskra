import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@iskra/marketing...'",
  buildCommand: "vp run --filter @iskra/marketing build",
  outputDirectory: "dist",
  redirects: [
    {
      source: "/app",
      destination: "https://app.iskra.sh",
      permanent: true,
    },
  ],
};
