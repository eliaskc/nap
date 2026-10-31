import { Globe2Icon, LockIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { EVERYONE_LABEL } from "~/lib/deployment-text";
import { cn } from "~/lib/utils";

export type Visibility = "everyone" | "private" | "selected";
export type Access = { visibility: Visibility; emails: Array<string> };

type Person = { email: string; name: string | null };
type General = "invited" | "everyone";

const GENERAL_ITEMS: Array<{ label: string; value: General; icon: LucideIcon }> = [
  { label: "Only people invited", value: "invited", icon: LockIcon },
  { label: EVERYONE_LABEL, value: "everyone", icon: Globe2Icon },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who can view a site: everyone, or only invited people. "Just me" is "invited" with nobody in
 * the list. Suggests known Nap users from /api/people; any full address can also be added.
 */
export function ShareAccess({
  value,
  onChange,
  disabled = false,
}: {
  value: Access;
  onChange: (next: Access) => void;
  disabled?: boolean;
}) {
  const { me, people, names } = usePeople();
  const general: General = value.visibility === "everyone" ? "everyone" : "invited";
  const domain = me ? me.email.slice(me.email.lastIndexOf("@") + 1) : null;

  function setEmails(emails: Array<string>) {
    onChange({ visibility: emails.length > 0 ? "selected" : "private", emails });
  }

  return (
    <div className="flex flex-col gap-3">
      <Select
        items={GENERAL_ITEMS}
        value={general}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(
            next === "everyone"
              ? { visibility: "everyone", emails: value.emails }
              : {
                  visibility: value.emails.length > 0 ? "selected" : "private",
                  emails: value.emails,
                },
          )
        }
      >
        <SelectTrigger aria-label="General access" className="w-full">
          <SelectValue>
            {(selected: General) => {
              const item = GENERAL_ITEMS.find((option) => option.value === selected);
              return item ? (
                <>
                  <item.icon />
                  {item.label}
                </>
              ) : null;
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {GENERAL_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <item.icon />
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {general === "invited" && (
        <>
          <PeopleSearch
            people={people}
            names={names}
            added={value.emails}
            disabled={disabled}
            onAdd={(email) => setEmails([...value.emails, email])}
          />
          <ul className="flex flex-col gap-1">
            {me && (
              <PersonRow email={me.email} name={me.name} suffix="(you)">
                <span className="pr-2 text-xs text-muted-foreground">Owner</span>
              </PersonRow>
            )}
            {value.emails.map((email) => {
              const outside = domain !== null && !email.endsWith(`@${domain}`);
              return (
                <PersonRow
                  key={email}
                  email={email}
                  name={names.get(email) ?? null}
                  unknown={!names.has(email)}
                  warning={
                    outside
                      ? `Outside ${domain}. Cloudflare Access can block this person.`
                      : undefined
                  }
                >
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Remove ${email}`}
                    onClick={() => setEmails(value.emails.filter((item) => item !== email))}
                  >
                    <XIcon />
                  </Button>
                </PersonRow>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Picks one person to become a nap's new owner. Suggestions leave out the caller, who owns it
 * already.
 */
export function OwnerPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (email: string) => void;
  disabled?: boolean;
}) {
  const { people, names } = usePeople();
  if (value) {
    return (
      <ul className="flex flex-col gap-1">
        <PersonRow email={value} name={names.get(value) ?? null} unknown={!names.has(value)}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`Choose someone other than ${value}`}
            onClick={() => onChange("")}
          >
            <XIcon />
          </Button>
        </PersonRow>
      </ul>
    );
  }
  return (
    <PeopleSearch
      people={people}
      names={names}
      added={[]}
      disabled={disabled}
      placeholder="Search for the new owner…"
      onAdd={onChange}
    />
  );
}

/** The caller and known Nap users in their email domain, from /api/people. */
function usePeople() {
  const [me, setMe] = React.useState<Person | null>(null);
  const [people, setPeople] = React.useState<Array<Person>>([]);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/people")
      .then(
        (response): Promise<{ me?: Person; people?: Array<Person> }> =>
          response.ok ? response.json() : Promise.resolve({}),
      )
      .then((body) => {
        if (cancelled) return;
        setMe(body.me ?? null);
        setPeople(body.people ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const names = React.useMemo(
    () => new Map(people.map((person) => [person.email, person.name])),
    [people],
  );
  return { me, people, names };
}

function PersonRow({
  email,
  name,
  suffix,
  unknown = false,
  warning,
  children,
}: {
  email: string;
  name: string | null;
  suffix?: string;
  unknown?: boolean;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium uppercase",
            unknown ? "border border-dashed text-muted-foreground" : "bg-muted",
          )}
        >
          {(name ?? email).charAt(0)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">
            {name ?? email}
            {suffix && <span className="text-muted-foreground"> {suffix}</span>}
          </span>
          {name && <span className="truncate text-xs text-muted-foreground">{email}</span>}
        </span>
        {children}
      </div>
      {warning && (
        <p className="flex items-start gap-1.5 pl-11 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          {warning}
        </p>
      )}
    </li>
  );
}

function PeopleSearch({
  people,
  names,
  added,
  disabled,
  placeholder = "Search for people to invite…",
  onAdd,
}: {
  people: Array<Person>;
  names: Map<string, string | null>;
  added: Array<string>;
  disabled: boolean;
  placeholder?: string;
  onAdd: (email: string) => void;
}) {
  const anchor = React.useRef<HTMLDivElement | null>(null);
  const [input, setInput] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const highlighted = React.useRef<string | undefined>(undefined);

  const typed = input.trim().toLowerCase();
  // People already added are left out, so selecting can only add, never remove.
  // A full address that is not a known person can still be added.
  const options = React.useMemo(() => {
    const addedSet = new Set(added);
    const known = people.map((person) => person.email).filter((email) => !addedSet.has(email));
    return EMAIL_PATTERN.test(typed) && !names.has(typed) && !addedSet.has(typed)
      ? [typed, ...known]
      : known;
  }, [people, names, typed, added]);

  function matches(email: string, query: string) {
    const q = query.trim().toLowerCase();
    if (!q || email === q) return true;
    return email.includes(q) || Boolean(names.get(email)?.toLowerCase().includes(q));
  }

  function add(email: string) {
    onAdd(email);
    setInput("");
  }

  return (
    <Combobox
      multiple
      items={options}
      value={added}
      onValueChange={(next: Array<string>, details) => {
        // Base UI clears all selected values on Escape while the popup is closed.
        if (details.reason === "escape-key") return;
        const email = next.find((item) => !added.includes(item));
        if (email) add(email);
      }}
      inputValue={input}
      onInputValueChange={setInput}
      open={open && typed.length > 0}
      onOpenChange={setOpen}
      onItemHighlighted={(email: string | undefined) => {
        highlighted.current = email;
      }}
      filter={matches}
      itemToStringLabel={(email: string) => names.get(email) ?? email}
      autoHighlight
      disabled={disabled}
    >
      <div ref={anchor}>
        <ComboboxInput
          showTrigger={false}
          className="w-full"
          // Not the user's own address: keep browser autofill and password managers away.
          // type="search": Bitwarden and 1Password skip search fields, and data-bwignore is
          // opt-in. Chrome guesses from name/id/label/placeholder, so none of them may say
          // "email", "name", "user" or "login".
          type="search"
          inputMode="email"
          name="share-with"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          aria-label="Add a person"
          placeholder={placeholder}
          onKeyDown={(event) => {
            // Tab adds the highlighted person, like Enter.
            if (event.key !== "Tab" || event.shiftKey || !open || !typed) return;
            const email = highlighted.current;
            if (!email || !options.includes(email)) return;
            event.preventDefault();
            add(email);
          }}
        />
      </div>
      {/* Anchor to the whole field, not the inner input, so the popup lines up with it. */}
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No match. Type a full address.</ComboboxEmpty>
        <ComboboxList>
          {(email: string) => {
            const name = names.get(email);
            return (
              <ComboboxItem key={email} value={email} className="group/person gap-3 py-1.5 pr-2">
                <span
                  aria-hidden
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium uppercase",
                    name === undefined ? "border border-dashed text-muted-foreground" : "bg-muted",
                  )}
                >
                  {(name ?? email).charAt(0)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{name ?? email}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {name ? email : "Invite by address"}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground group-data-highlighted/person:inline">
                  tab to add
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
