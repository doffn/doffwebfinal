# Dawit Neri — Django Portfolio

A responsive Django portfolio presenting Dawit Neri as an Engine Shop Powerplant Technician at Ethiopian Airlines MRO, an Electromechanical Engineering graduate, and a software/AI builder.

## Features

- Responsive portfolio sections: profile, aviation/MRO, interactive engine explorer, technology, projects and contact.
- Locally bundled GEnx-inspired educational turbofan cutaway at `staticfiles/models/genx-inspired-cutaway.glb` (GLB 2.0; 1,358 meshes). The viewer loads this file through Django's `{% static %}` URL; the model is not downloaded from a model host at runtime.
- Three.js viewer with drag-to-rotate, scroll-to-zoom, auto-rotation, assembled/exploded views, reset and module selection. Selecting a module card highlights its axial region; clicking named model geometry selects its corresponding module, with axial-position fallback for unnamed geometry.
- Electric-blue wireframe portrait with subtle pointer tracking and motion.
- Telegram contact forwarding for text and allow-listed image, voice/audio, video and document attachments. Bot credentials remain server-side environment variables.
- CSRF protection, honeypot field, upload limits and basic per-IP throttling.

## Engine model accuracy and scope

The bundled GLB is an original generated educational illustration inspired by a high-bypass turbofan architecture. It is **not** GEnx-1B OEM CAD, approved engineering data, dimensionally validated geometry, or maintenance/training sign-off material. It must not be used for inspection, repair, maintenance or airworthiness decisions. The geometry includes a fan, 4 booster stages, 10 HPC stages, 2 HPT stages and 6 LPT stages; counts shown in the module cards reflect this asset.

Three.js, OrbitControls and GLTFLoader are loaded from jsDelivr as ES modules, so the viewer requires internet access for those JavaScript libraries. The GLB itself is bundled locally.

## Local setup

Python 3.10+ recommended.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Open `http://127.0.0.1:8000/`. The portfolio pages work without Telegram configuration; the contact endpoint requires the environment variables below to forward messages.

## Telegram contact setup

1. Create a bot with BotFather.
2. Add it as an administrator to the destination channel with permission to post messages and media.
3. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` on the server. `TELEGRAM_CHAT_ID` may be a channel username such as `@your_channel_username` or a numeric channel ID.
4. Configure `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` and `DJANGO_DEBUG=false` for production.

Never put the Telegram token in browser JavaScript, HTML, GitHub or client-side build variables.

## Static files and deployment

Django settings define `STATIC_URL = "/static/"`, include the project `staticfiles/` directory in `STATICFILES_DIRS`, and collect production assets into `staticfiles_build/static` via `STATIC_ROOT`. The template references the model with `{% static 'models/genx-inspired-cutaway.glb' %}`.

For a standard Python host:

```bash
pip install -r requirements.txt
python manage.py check
python manage.py collectstatic --noinput
gunicorn myProject.wsgi:application
```

The project includes a legacy `vercel.json`; verify the current Vercel Python runtime and Django static-file requirements before deployment. A conventional Python/Django host is recommended if the deployment platform does not support Django request handling and uploads.

## Environment variables

See `.env.example`. Do not commit real credentials.

## Project structure

- `myProject/` — Django settings, URL configuration and WSGI entry point.
- `myApp/` — views, contact handling, routes and templates.
- `staticfiles/portfolio.css` and `portfolio.js` — visual system and interactions.
- `staticfiles/engine-viewer.js` — Three.js GLB viewer.
- `staticfiles/models/genx-inspired-cutaway.glb` — local educational model.
- `staticfiles/face-wireframe.js` — animated portrait effect.
