# First fix: Replace console.log with this.logger.log
(Get-Content "auth.service.ts") -replace "console.log('🔍 SignUp attempt:', {", "// Enhanced validation" | Set-Content "auth.service.ts"
