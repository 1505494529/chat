-- GitHub Pages + Supabase 版本初始化脚本。
-- 先在 Authentication -> Providers 中打开 Anonymous Sign-Ins，
-- 再在 SQL Editor 执行本文件。

create table if not exists public.messages (
  id uuid primary key,
  kind text not null check (kind in ('text', 'image', 'file')),
  text text not null default '',
  file_url text not null default '',
  storage_path text,
  name text not null default '未命名文件',
  mime text not null default 'application/octet-stream',
  size bigint not null default 0,
  nickname text not null default '访客',
  session_id text not null,
  color text not null default '#6c63ff',
  created_at timestamptz not null default now()
);

create index if not exists messages_created_at_idx
  on public.messages (created_at desc);

alter table public.messages enable row level security;
alter table public.messages replica identity full;

drop policy if exists "chat authenticated users can read messages" on public.messages;
create policy "chat authenticated users can read messages"
  on public.messages for select
  to authenticated
  using (true);

drop policy if exists "chat users can insert their own messages" on public.messages;
create policy "chat users can insert their own messages"
  on public.messages for insert
  to authenticated
  with check (session_id = (select auth.uid()::text));

drop policy if exists "chat users can delete their own messages" on public.messages;
create policy "chat users can delete their own messages"
  on public.messages for delete
  to authenticated
  using (session_id = (select auth.uid()::text));

insert into storage.buckets (id, name, public)
values ('chat-files', 'chat-files', true)
on conflict (id) do update set public = true;

drop policy if exists "chat authenticated users can upload files" on storage.objects;
create policy "chat authenticated users can upload files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'chat-files');

drop policy if exists "chat users can delete their own files" on storage.objects;
create policy "chat users can delete their own files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'chat-files' and owner_id = (select auth.uid()::text));

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end
$$;
