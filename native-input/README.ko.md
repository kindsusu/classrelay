# ClassRelay InputGuard (Windows 선택형 입력 잠금 helper)

[English](README.md)

`InputGuard.exe`는 Student Agent에서 선택적으로 사용하는 Windows 전용 helper다. 관리자 권한이나 `BlockInput` 없이 현재 대화형 세션의 저수준 키보드·마우스 훅(`WH_KEYBOARD_LL`, `WH_MOUSE_LL`)을 사용한다.

Windows PowerShell에서 빌드한다.

```powershell
.\native-input\build.ps1
```

실행 파일은 표준 입력에서 UTF-8 텍스트 명령을 읽고 표준 출력으로 상태 줄을 보낸다.

```text
LOCK 42       # revision 42를 최대 15초 동안 잠그거나 갱신
UNLOCK        # 즉시 해제
```

각 `LOCK <revision>`은 lease를 최대 15초까지만 연장한다. Controller 또는 Agent가 갱신을 멈추면 helper가 자동으로 입력을 해제한다. EOF도 입력을 해제하고 프로세스를 종료한다. `Ctrl+Shift+F12`는 항상 사용 가능한 비상 해제이며 `UNLOCKED emergency`를 출력한다. 같은 revision은 `UNLOCK` 또는 더 새로운 lock revision이 올 때까지 해제 상태로 유지된다.

실제 입력을 억제하지 않는 상태 테스트를 실행한다.

```powershell
.\native-input\dist\InputGuard.exe --self-test
```

제한 사항: Ctrl+Alt+Del 같은 보안 주의 키는 Windows 보안 데스크톱에서 처리되므로 가로채거나 억제할 수 없다. 이 도구는 최선 노력 방식의 현재 세션 입력 잠금일 뿐 보안 경계가 아니다. 관리자, 다른 세션, 정책 제어 또는 재부팅으로 해제될 수 있다. 입력 이벤트나 키 입력을 기록하지 않는다.
