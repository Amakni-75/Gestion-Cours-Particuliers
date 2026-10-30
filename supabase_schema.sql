-- Supabase/PostgreSQL schema for the tutoring app.
-- Each authenticated user owns a private dataset. No service-role key belongs
-- in the browser or in the GitHub repository.

begin;

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    status text not null default 'pending'
        check (status in ('pending', 'approved', 'rejected')),
    role text not null default 'user'
        check (role in ('user', 'admin')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, email)
    values (new.id, coalesce(new.email, ''));
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.create_profile_for_new_user();

create or replace function public.is_approved_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where id = (select auth.uid())
          and status = 'approved'
    );
$$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where id = (select auth.uid())
          and status = 'approved'
          and role = 'admin'
    );
$$;

create table if not exists public.students (
    student_id text primary key,
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    full_name text not null check (length(trim(full_name)) > 0),
    created_at timestamptz not null default now(),
    unique (owner_id, student_id)
);

create table if not exists public.subjects (
    subject_id text primary key,
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    name text not null check (length(trim(name)) > 0),
    created_at timestamptz not null default now(),
    unique (owner_id, subject_id),
    unique (owner_id, name)
);

create table if not exists public.student_subjects (
    assignment_id text primary key,
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    student_id text not null,
    subject_id text not null,
    rate_millimes integer not null check (rate_millimes >= 0),
    assigned_at timestamptz not null default now(),
    unique (owner_id, student_id, subject_id),
    foreign key (owner_id, student_id)
        references public.students(owner_id, student_id) on delete cascade,
    foreign key (owner_id, subject_id)
        references public.subjects(owner_id, subject_id) on delete cascade
);

create table if not exists public.payment_cycles (
    payment_cycle_id text primary key,
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    student_id text not null,
    cycle_number integer not null check (cycle_number > 0),
    is_paid boolean not null default false,
    created_at timestamptz not null default now(),
    unique (owner_id, student_id, cycle_number),
    unique (owner_id, payment_cycle_id),
    foreign key (owner_id, student_id)
        references public.students(owner_id, student_id) on delete cascade
);

create table if not exists public.sessions (
    session_id text primary key,
    owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    student_id text not null,
    subject_id text not null,
    payment_cycle_id text not null,
    session_date date not null,
    -- Snapshot the agreed price; later rate changes must not rewrite history.
    rate_millimes integer not null check (rate_millimes >= 0),
    notes text,
    created_at timestamptz not null default now(),
    foreign key (owner_id, student_id)
        references public.students(owner_id, student_id) on delete cascade,
    foreign key (owner_id, subject_id)
        references public.subjects(owner_id, subject_id) on delete restrict,
    foreign key (owner_id, payment_cycle_id)
        references public.payment_cycles(owner_id, payment_cycle_id) on delete cascade
);

create index if not exists idx_students_owner_name
    on public.students(owner_id, full_name);
create index if not exists idx_subjects_owner_name
    on public.subjects(owner_id, name);
create index if not exists idx_student_subjects_owner_student
    on public.student_subjects(owner_id, student_id);
create index if not exists idx_sessions_owner_date
    on public.sessions(owner_id, session_date);
create index if not exists idx_sessions_owner_student_date
    on public.sessions(owner_id, student_id, session_date);
create index if not exists idx_sessions_owner_subject_date
    on public.sessions(owner_id, subject_id, session_date);
create index if not exists idx_sessions_owner_cycle
    on public.sessions(owner_id, payment_cycle_id);

do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'students',
        'subjects',
        'student_subjects',
        'payment_cycles',
        'sessions'
    ]
    loop
        if not exists (
            select 1
            from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = table_name
        ) then
            execute format('alter publication supabase_realtime add table public.%I', table_name);
        end if;
    end loop;
end;
$$;

create or replace function public.enforce_four_sessions_per_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    cycle_count integer;
begin
    perform 1
    from public.payment_cycles
    where owner_id = new.owner_id
      and payment_cycle_id = new.payment_cycle_id
    for update;

    select count(*) into cycle_count
    from public.sessions
    where owner_id = new.owner_id
      and payment_cycle_id = new.payment_cycle_id
      and session_id is distinct from new.session_id;

    if cycle_count >= 4 then
        raise exception 'A payment cycle cannot contain more than four sessions';
    end if;

    return new;
end;
$$;

drop trigger if exists sessions_max_four_per_cycle on public.sessions;
create trigger sessions_max_four_per_cycle
    before insert or update of owner_id, payment_cycle_id on public.sessions
    for each row execute function public.enforce_four_sessions_per_cycle();

create or replace function public.payment_cycle_summary()
returns table (
    payment_cycle_id text,
    owner_id uuid,
    student_id text,
    cycle_number integer,
    session_count bigint,
    total_millimes bigint,
    is_paid boolean,
    status text
)
language sql
stable
security invoker
set search_path = ''
as $$
    select
        pc.payment_cycle_id,
        pc.owner_id,
        pc.student_id,
        pc.cycle_number,
        count(s.session_id) as session_count,
        coalesce(sum(s.rate_millimes), 0)::bigint as total_millimes,
        pc.is_paid,
        case
            when count(s.session_id) < 4 then 'in_progress'
            when pc.is_paid then 'paid'
            else 'due'
        end as status
    from public.payment_cycles as pc
    left join public.sessions as s
      on s.owner_id = pc.owner_id
     and s.payment_cycle_id = pc.payment_cycle_id
    group by pc.payment_cycle_id, pc.owner_id, pc.student_id, pc.cycle_number, pc.is_paid;
$$;

alter table public.profiles enable row level security;
alter table public.students enable row level security;
alter table public.subjects enable row level security;
alter table public.student_subjects enable row level security;
alter table public.payment_cycles enable row level security;
alter table public.sessions enable row level security;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
    on public.profiles for select to authenticated
    using (id = (select auth.uid()) or (select public.is_admin_user()));

drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update"
    on public.profiles for update to authenticated
    using ((select public.is_admin_user()))
    with check (status in ('pending', 'approved', 'rejected') and role in ('user', 'admin'));

drop policy if exists "students_owner_access" on public.students;
create policy "students_owner_access"
    on public.students for all to authenticated
    using (owner_id = (select auth.uid()) and (select public.is_approved_user()))
    with check (owner_id = (select auth.uid()) and (select public.is_approved_user()));

drop policy if exists "subjects_owner_access" on public.subjects;
create policy "subjects_owner_access"
    on public.subjects for all to authenticated
    using (owner_id = (select auth.uid()) and (select public.is_approved_user()))
    with check (owner_id = (select auth.uid()) and (select public.is_approved_user()));

drop policy if exists "student_subjects_owner_access" on public.student_subjects;
create policy "student_subjects_owner_access"
    on public.student_subjects for all to authenticated
    using (owner_id = (select auth.uid()) and (select public.is_approved_user()))
    with check (owner_id = (select auth.uid()) and (select public.is_approved_user()));

drop policy if exists "payment_cycles_owner_access" on public.payment_cycles;
create policy "payment_cycles_owner_access"
    on public.payment_cycles for all to authenticated
    using (owner_id = (select auth.uid()) and (select public.is_approved_user()))
    with check (owner_id = (select auth.uid()) and (select public.is_approved_user()));

drop policy if exists "sessions_owner_access" on public.sessions;
create policy "sessions_owner_access"
    on public.sessions for all to authenticated
    using (owner_id = (select auth.uid()) and (select public.is_approved_user()))
    with check (owner_id = (select auth.uid()) and (select public.is_approved_user()));

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete
    on public.students, public.subjects, public.student_subjects,
       public.payment_cycles, public.sessions
    to authenticated;
revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke all on function public.is_approved_user() from public, anon;
revoke all on function public.is_admin_user() from public, anon;
revoke all on function public.enforce_four_sessions_per_cycle() from public, anon, authenticated;
revoke all on function public.payment_cycle_summary() from public, anon;
grant execute on function public.is_approved_user() to authenticated;
grant execute on function public.is_admin_user() to authenticated;
grant execute on function public.payment_cycle_summary() to authenticated;

commit;

-- After signing up with the administrator account and confirming its email,
-- promote it once from the Supabase SQL Editor (replace the email):
-- update public.profiles
-- set role = 'admin', status = 'approved', updated_at = now()
-- where lower(email) = lower('admin@example.com');
