import { FilterBar, UploadError } from "~/dashboard/chrome";
import { ExampleDots, ExampleText, PromptButtons, useExample } from "~/dashboard/connect";
import { PhoneInstallBanner } from "~/dashboard/install";
import { ItemCollection } from "~/dashboard/items";
import type { VariantProps } from "~/dashboard/variants/types";

/** Tidy: the prompt is the headline, with everything you can see below it. */
export function HeadlineLayout({ view, loading, bar }: VariantProps) {
  const index = useExample();
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      <div className="nap-dot-field" />
      {bar({ className: "sticky top-0" })}
      <main className="relative z-10 mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 pt-8 pb-16 sm:pt-12">
        <PhoneInstallBanner className="-mt-4 mb-2 sm:hidden" />
        <section className="flex flex-col gap-5" aria-label="Connect your agent">
          <span className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
            Ask your agent
          </span>
          <h1 className="text-3xl leading-[1.1] font-semibold tracking-[-0.035em] sm:text-[2.5rem]">
            <ExampleText index={index} restClassName="text-muted-foreground" />
          </h1>
          <div className="flex items-center gap-4">
            <PromptButtons size="lg" />
            <ExampleDots index={index} className="ml-auto text-foreground max-sm:hidden" />
          </div>
        </section>
        <div className="h-8" />
        <FilterBar view={view} showLook />
        <UploadError />
        <ItemCollection view={view} loading={loading} />
      </main>
    </div>
  );
}
