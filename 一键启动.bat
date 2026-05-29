@echo off
chcp 65001 >nul
echo 正在启动项目收款统计系统...
if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate
pip install -r requirements.txt
python app.py
pause
