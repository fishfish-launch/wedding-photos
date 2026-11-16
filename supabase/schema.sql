-- 結婚式フォト共有アプリ用のDB定義
-- __EVENT_CODE__ : ゲスト用の合言葉（QRコードのURLに入る）
-- __ADMIN_CODE__ : 新郎新婦用の合言葉（写真の非表示ができる）
-- shot_limit     : 1人（1台）あたりの撮影枚数の上限。あとから変えるときは
--                  update private.settings set shot_limit = 30;

create schema if not exists private;

create table private.settings (
  id boolean primary key default true check (id),
  event_code text not null,
  admin_code text not null,
  shot_limit int not null default 24
);
insert into private.settings (event_code, admin_code) values ('__EVENT_CODE__', '__ADMIN_CODE__');

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  path text not null unique,
  thumb_path text not null,
  guest_name text,
  device_id text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index photos_created_at_idx on public.photos (created_at);
create index photos_device_idx on public.photos (device_id);

-- 直接の読み書きは全て禁止し、合言葉を確認する関数経由だけにする
alter table public.photos enable row level security;
alter table private.settings enable row level security;

create function private.is_event_code(code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.settings where event_code = code);
$$;

create function public.list_photos(p_code text, p_since timestamptz default null)
returns table (id uuid, path text, thumb_path text, guest_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_event_code(p_code) then
    raise exception 'invalid code' using errcode = '28000';
  end if;
  return query
    select p.id, p.path, p.thumb_path, p.guest_name, p.created_at
    from public.photos p
    where not p.hidden and (p_since is null or p.created_at > p_since)
    order by p.created_at;
end $$;

-- その端末が何枚使ったかと上限
create function public.get_quota(p_code text, p_device text)
returns table (used int, shot_limit int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_event_code(p_code) then
    raise exception 'invalid code' using errcode = '28000';
  end if;
  return query
    select (select count(*)::int from public.photos p where p.device_id = p_device),
           (select s.shot_limit from private.settings s);
end $$;

create function public.add_photo(p_code text, p_path text, p_thumb_path text, p_device text, p_guest_name text default null)
returns table (id uuid, path text, thumb_path text, guest_name text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_event_code(p_code) then
    raise exception 'invalid code' using errcode = '28000';
  end if;
  if p_path !~ ('^' || p_code || '/[0-9a-f-]{36}\.jpg$')
     or p_thumb_path !~ ('^' || p_code || '/[0-9a-f-]{36}_t\.jpg$') then
    raise exception 'invalid path';
  end if;
  if p_device !~ '^[0-9a-f-]{36}$' then
    raise exception 'invalid device';
  end if;
  if (select count(*) from public.photos q where q.device_id = p_device)
     >= (select s.shot_limit from private.settings s) then
    raise exception 'limit reached';
  end if;
  if (select count(*) from storage.objects o
      where o.bucket_id = 'photos' and o.name in (p_path, p_thumb_path)) <> 2 then
    raise exception 'file not uploaded';
  end if;
  return query
    insert into public.photos as p (path, thumb_path, device_id, guest_name)
    values (p_path, p_thumb_path, p_device, nullif(left(trim(p_guest_name), 30), ''))
    returning p.id, p.path, p.thumb_path, p.guest_name, p.created_at;
end $$;

create function public.hide_photo(p_admin_code text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.settings where admin_code = p_admin_code) then
    raise exception 'invalid code' using errcode = '28000';
  end if;
  update public.photos set hidden = true where id = p_id;
end $$;

revoke execute on function public.list_photos, public.get_quota, public.add_photo, public.hide_photo from public, authenticated;
grant execute on function public.list_photos, public.get_quota, public.add_photo, public.hide_photo to anon;
grant usage on schema private to anon;
grant execute on function private.is_event_code to anon;

-- 写真置き場。JPEGのみ、1枚8MBまで。合言葉フォルダの中にだけアップロードできる
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 8388608, array['image/jpeg']);

create policy "guests upload with event code" on storage.objects
for insert to anon
with check (bucket_id = 'photos' and private.is_event_code((storage.foldername(name))[1]));
