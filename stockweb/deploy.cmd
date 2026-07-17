@echo off
rem 部署 stockweb 到本機 shioaji server（http://localhost:8080/apps/stockweb/）
cd /d %~dp0
shioaji apps upload --name stockweb --dir .
echo.
echo 完成：http://localhost:8080/apps/stockweb/
pause
