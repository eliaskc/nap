import { Container } from "@cloudflare/containers";

/**
 * The app signer: a Cloudflare Container (containers/signer) that signs unsigned iOS builds with
 * rcodesign, and Android App Bundles with the Play upload key. Nap never builds apps; it only signs
 * them, so the certificate and the upload key never leave Nap.
 *
 * The certificate and the key reach the container as environment variables when it starts. The container
 * has no internet access. One instance signs everything and sleeps when idle.
 */
export class AppSigner extends Container<Cloudflare.Env> {
  defaultPort = 8080;
  sleepAfter = "3m";
  enableInternet = false;

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    super(ctx, env);
    const pem = (value: unknown) => String(value ?? "").replace(/\\n/g, "\n");
    this.envVars = {
      SIGNING_PEM: pem(env.NAP_APPLE_SIGNING_PEM),
      ANDROID_UPLOAD_PEM: pem(env.NAP_ANDROID_UPLOAD_PEM),
    };
  }
}
