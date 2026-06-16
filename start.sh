#!/bin/bash
export WindowsSdkDir="D:/Dev/IDE/VS/VSIDE/Windows Kits/10/"
export VCToolsInstallDir="D:/Dev/IDE/VS/VSIDE/VC/Tools/MSVC/14.50.35717/"
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
cd "$(dirname "$0")"
bun dev
