[English](README.md) | Tiếng Việt

# ai-quota-bar (AI Quota Bar)

Tiện ích VS Code hiện quota còn lại của **Claude Code**, **Codex**, **Antigravity (`agy`)** và số dư API của **DeepSeek** trên thanh trạng thái. Mỗi nhà cung cấp (provider) đang bật có một mục riêng trên thanh trạng thái với mã định danh (ID) riêng (`aiQuota.claude`, `aiQuota.codex`, `aiQuota.agy`, `aiQuota.deepseek`), và cả bốn đều không cần mở một IDE riêng hay phát sinh lượt gọi model.

Hình dung bằng chữ góc phải thanh trạng thái (chưa có tệp ảnh chụp màn hình thật):

```
+------------------+  +-----------------+  +-----------------------------------------+  +-----------------+
| Claude 84% | 29% |  | Codex 76% | 96% |  | Gemini 91% | 60% · Claude/GPT 80% | 55% |  | DeepSeek $10.00 |
+------------------+  +-----------------+  +-----------------------------------------+  +-----------------+
```

## 1. Mục đích

Tiện ích hiện phần trăm quota còn lại (hoặc số dư tài khoản với DeepSeek) của các công cụ lập trình AI trên thanh trạng thái VS Code, đổi màu nền và bật thông báo khi một giới hạn hoặc số dư xuống mức cảnh báo hoặc nghiêm trọng, và cho biết thời điểm từng giới hạn theo khung thời gian được đặt lại (reset).

Tiện ích gộp bốn nguồn dữ liệu trong một gói duy nhất:

| Nguồn (Provider) | Nguồn dữ liệu | Nhóm hiển thị | Cửa sổ giới hạn / Giá trị thường gặp |
|---|---|---|---|
| Claude Code (`claude`) | API OAuth usage của Anthropic (`https://api.anthropic.com/api/oauth/usage`) dùng token mà Claude Code đã lưu | `Claude` | 5 giờ (`session` / `five_hour`), Tuần (`weekly_all` / `seven_day`), kèm các giới hạn tuần theo model từ mảng `limits` (lấy nhãn model từ API) hoặc trường cũ `seven_day_opus` / `seven_day_sonnet` |
| Codex (`codex`) | API backend usage của ChatGPT (`https://chatgpt.com/backend-api/wham/usage`) dùng token mà Codex đã lưu | `Codex` | 5 giờ (`18000` giây), Tuần (`604800` giây), hoặc khung thời gian khác do API trả về |
| Antigravity (`agy`) | Lệnh CLI `agy --output-format json -p "/usage"` | `Gemini`, `Claude/GPT` | 5 giờ, Tuần |
| DeepSeek (`deepseek`) | API số dư người dùng của DeepSeek (`https://api.deepseek.com/user/balance`) dùng `DEEPSEEK_API_KEY` hoặc `~/.codewhale/secrets/secrets.json` | `DeepSeek` | Số dư tiền theo từng loại tiền tệ (`USD`, `CNY`, ... gồm tổng số dư, số dư đã nạp và số dư được tặng; không có phần trăm theo khung thời gian hay thời điểm reset) |

Gỡ trùng với các tiện ích quota khác:

- **Thay thế `XXLC.agy-quota-bar`**: `ai-quota-bar` là bản kế nhiệm đa nhà cung cấp của `XXLC.agy-quota-bar`, giữ nguyên mục thanh trạng thái Antigravity, tooltip bảng Markdown, danh sách QuickPick, thông báo khi đổi mức và cơ chế khóa tệp giữa nhiều cửa sổ. Nếu đã cài `XXLC.agy-quota-bar`, hãy gỡ hoặc tắt tiện ích đó để không chạy `agy` hai lần mỗi chu kỳ. Giống `agy-quota-bar`, tiện ích lấy số liệu Antigravity qua lệnh `agy` CLI thay vì language server của Antigravity IDE (khác `clhome.antigravity-quota-yufeng`), nên vẫn hoạt động bình thường khi đóng Antigravity IDE.
- **Các tiện ích quota Claude Code, Codex và Antigravity riêng lẻ**: Bạn nên tắt các tiện ích xem quota riêng cho Claude Code, Codex hoặc Antigravity để tránh gọi API hoặc chạy CLI trùng lặp và tránh lặp mục trên thanh trạng thái (không bắt buộc phải gỡ vì `ai-quota-bar` chỉ đọc tệp đăng nhập, không bao giờ ghi tệp hay làm mới token).

## 2. Cách hoạt động

Mỗi provider đang bật tự làm mới độc lập theo nhịp riêng và lưu trạng thái vào tệp riêng. Lỗi ở một provider không làm chặn hay chậm các provider còn lại.

### 2.1. Claude Code (`claude`)

Vì sao dùng nguồn này: Sau khi bạn đăng nhập, Claude Code lưu sẵn OAuth access token trên đĩa. Gọi trực tiếp điểm cuối OAuth usage của Anthropic bằng token đó giúp lấy đúng tỷ lệ sử dụng 5 giờ, tuần và theo từng model mà không cần mở phiên `claude` tương tác hay tiêu tốn token của model.

Mỗi lần làm mới Claude, tiện ích:

1. Đọc tệp `<CLAUDE_CONFIG_DIR hoặc ~/.claude>/.credentials.json` (hoặc thư mục cấu hình trong `aiQuota.claudeConfigDir`), lấy `claudeAiOauth.accessToken` và kiểm tra `claudeAiOauth.expiresAt` (cùng trường `exp` của JWT nếu có). Nếu tệp hoặc token bị thiếu hay đã hết hạn, tiện ích báo lỗi `auth` ngay mà không gọi mạng.
2. Gửi `GET https://api.anthropic.com/api/oauth/usage` với header `Authorization: Bearer <accessToken>`, `Accept: application/json`, `User-Agent: ai-quota-bar/0.2.0` và `anthropic-beta: oauth-2025-04-20`.
3. Dùng `fetch` dựng sẵn của Node trước. Chỉ khi `fetch` nhận mã HTTP `403` có nội dung phản hồi chứa `"Request not allowed"` (máy chủ biên của Anthropic từ chối dấu vân tay TLS ClientHello của Node), tiện ích mới chuyển sang dự phòng một lần bằng chương trình `curl` của hệ thống (`<%SystemRoot% hoặc C:\Windows>\System32\curl.exe` trên Windows, `curl` trên macOS/Linux) với `-q --config -`, truyền địa chỉ và header qua `stdin` để token không bao giờ xuất hiện trong dòng lệnh của tiến trình.
4. Phân tích phản hồi JSON, ưu tiên mảng `limits` (Anthropic bổ sung từ 08/2026, có giới hạn theo từng model) khi mảng này có ít nhất một phần tử hợp lệ, và dự phòng về các trường cấp cao nhất kiểu cũ nếu không có (không trộn lẫn hai định dạng):
   - Từ mảng `limits`: ánh xạ `kind === 'session'` (hoặc `kind` lạ có `group === 'session'`) sang 5 giờ (`5h`); ánh xạ `kind === 'weekly_all'` sang Tuần (`weekly`); ánh xạ `kind === 'weekly_scoped'` (hoặc `kind` lạ có `group === 'weekly'`) sang `other:<nhãn>`, trong đó `<nhãn>` lấy trực tiếp từ `scope.model.display_name` của API (nếu thiếu thì lấy `scope.surface`, hoặc `Tuần (<kind>)`), đã làm sạch và giới hạn tối đa 40 ký tự. Nếu hai mục trùng khóa cửa sổ, mục có tỷ lệ còn lại chưa làm tròn thấp hơn được giữ lại.
   - Từ các trường cũ (dự phòng khi `limits` không có mục hợp lệ): đọc `five_hour` (`5h`), `seven_day` (`weekly`), `seven_day_opus` (`other:Opus`, nhãn `Opus`) và `seven_day_sonnet` (`other:Sonnet`, nhãn `Sonnet`).
5. Chuyển phần trăm đã dùng (`percent` trong `limits` hoặc `utilization` ở trường cũ) thành phần trăm còn lại (`0-100`, làm tròn xuống bằng `Math.floor(100 - Math.min(100, used))`) dưới nhãn nhóm `Claude`, và đọc `resets_at` làm thời điểm reset. Phần trăm đã dùng `> 100` được kẹp về `100` và coi là đã hết (`0%` còn lại, mức nghiêm trọng); giá trị âm hoặc không hữu hạn bị bỏ qua.

### 2.2. Codex (`codex`)

Vì sao dùng nguồn này: Codex CLI lưu sẵn OAuth token trong `auth.json`. Gọi trực tiếp điểm cuối usage bằng token đó trả về ngay các cửa sổ giới hạn hiện hành mà không cần khởi chạy tiến trình `codex` hay tốn quota model.

Mỗi lần làm mới Codex, tiện ích:

1. Đọc tệp `<CODEX_HOME hoặc ~/.codex>/auth.json` (hoặc thư mục cấu hình trong `aiQuota.codexHome`), lấy `tokens.access_token` (và `tokens.account_id` nếu có), đồng thời kiểm tra hạn `exp` của JWT.
2. Gửi `GET https://chatgpt.com/backend-api/wham/usage` với header `Authorization: Bearer <access_token>`, `Accept: application/json`, `User-Agent: ai-quota-bar/0.2.0` và `chatgpt-account-id: <account_id>` nếu có. Khi gặp mã `401`, hoặc `403` có `Content-Type` là JSON (`application/json` hoặc `+json`), tiện ích báo lỗi `auth`; nếu `403` không phải JSON (chẳng hạn trang chặn HTML), tiện ích báo lỗi `HTTP 403`.
3. Đọc `rate_limit.primary_window` và `rate_limit.secondary_window` trong phản hồi JSON (chấp nhận cả số và chuỗi số hữu hạn cho `used_percent`, `limit_window_seconds`, `reset_at`, `reset_after_seconds`).
4. Ánh xạ `limit_window_seconds` sang khóa cửa sổ độc lập ngôn ngữ và nhãn hiển thị theo ngôn ngữ: `18000` thành `5h` (`5 giờ`), `604800` thành `weekly` (`Tuần`), thời lượng dương khác thành `other:<seconds>s` (nhãn theo số ngày chẵn, số giờ chẵn hoặc số phút làm tròn), và cửa sổ thiếu `limit_window_seconds` thành `other:primary` hoặc `other:secondary` (nhãn `Giới hạn`).
5. Chuyển `used_percent` thành phần trăm còn lại (`0-100`, làm tròn xuống) dưới nhãn nhóm `Codex`, kẹp mọi `used_percent > 100` về `0%` còn lại (mức nghiêm trọng). Tính thời điểm reset bằng `reset_at * 1000` nếu có, nếu không thì dùng `now + reset_after_seconds * 1000`.

### 2.3. Antigravity (`agy`)

Vì sao dùng nguồn này: `/usage` là lệnh nội bộ của `agy` CLI (không phải lời nhắc gửi model) và không khởi động language server của Antigravity IDE, nên chạy được trong cả VS Code lẫn Antigravity IDE ngay cả khi đã đóng Antigravity IDE.

Mỗi lần làm mới Antigravity, tiện ích chạy:

```
agy --output-format json -p "/usage"
```

Lệnh chạy trực tiếp (không qua shell), với tùy chọn ẩn cửa sổ (`windowsHide`), thư mục làm việc là thư mục nhà, biến môi trường `NO_COLOR=1`, giới hạn đầu ra 256 KiB, và `stdin` được đóng ngay. Tiện ích đọc kết quả JSON (trường `command.data.groups`, có tỷ lệ còn lại dạng số thực); nếu thiếu trường đó thì dùng bản văn bản dạng bảng TAB trong trường `response`, nhưng chỉ khi `conversation_id` có mặt và đúng bằng chuỗi rỗng. Ở cả chế độ JSON lẫn bảng TSV, một bucket được ánh xạ sang cửa sổ 5 giờ (`5h`) khi `window === '5h'` hoặc khi nhãn của nó (sau khi bỏ đuôi ` Limit Remaining`) khớp biểu thức `/five[\s-]*hour/i` (chấp nhận `Five-Hour`, `Five Hour`, `FiveHour` và các biến thể khoảng trắng hoặc dấu gạch ngang tương tự), ánh xạ sang cửa sổ tuần (`weekly`) khi `window === 'weekly'` hoặc nhãn khớp `/weekly/i`, và ánh xạ sang `other:<nhãn>` trong các trường hợp còn lại. `stdout` phải chứa một đối tượng JSON; khoảng trắng hoặc dòng trắng trước và sau được chấp nhận, còn nội dung khác ngoài JSON thì coi là lỗi.

Số liệu đo trên máy tác giả, Windows 11, `agy` 1.4.12:

| Điều kiểm | Kết quả đo |
|---|---|
| Mã thoát, kênh ghi | Luôn 0; kết quả ở `stdout`, `stderr` rỗng |
| Thời gian chạy | Khoảng 4 giây mỗi lần (3 907 ms khi chạy từ Node; 2,6-3,5 giây qua hơn 15 lần chạy khác) |
| Gọi model | Không: `num_turns` = 0, `conversation_id` rỗng, mọi trường token trong `usage` bằng 0 |
| Tiêu hao quota | Không: `remaining_fraction` của nhóm Gemini giữ nguyên tới chữ số thập phân thứ 16 qua 7 lần gọi liên tiếp |
| Tạo hội thoại | Không: thư mục `conversations` và `last_conversations.json` không đổi |
| Phụ thuộc thư mục làm việc | Không: chạy ở `C:\Windows\Temp` cho cùng kết quả |

> [!WARNING]
> Tiện ích không bao giờ truyền cờ `--disable-slash-commands`. Với cờ này, `agy` gửi chuỗi `/usage` cho model như một lời nhắc thường: trong lần đo trên máy tác giả, lần chạy mất 33,4 giây, tạo một hội thoại mới, tiêu token của model và trả về văn xuôi thay cho bảng quota. Để phòng trường hợp `agy` bản sau bỏ lệnh `/usage` (cũng dẫn tới việc gửi chuỗi đó cho model), tiện ích chỉ nhận kết quả khi `command.name` là `usage`, `num_turns` bằng 0, `conversation_id` không có giá trị truthy (chuỗi rỗng, vắng mặt, `null`, `false` và `0` đều vượt qua bước kiểm tra này) và `status` (nếu có) là `SUCCESS`. Không thỏa thì báo lỗi loại "kết quả không mong đợi" và giãn dần khoảng làm mới (mục 5) để không tiêu quota đều đặn. Nếu bạn tự chạy lệnh trên trong terminal, đừng thêm cờ này.

### 2.4. DeepSeek (`deepseek`)

Vì sao dùng nguồn này: DeepSeek cung cấp điểm cuối kiểm tra số dư (`GET https://api.deepseek.com/user/balance`) trả về trạng thái khả dụng của tài khoản (`is_available`) và chi tiết `total_balance`, `topped_up_balance`, `granted_balance` theo từng loại tiền tệ mà không phát sinh lượt gọi model. Khác với Claude Code, Codex và Antigravity, DeepSeek báo cáo số dư tiền tệ chứ không có phần trăm giới hạn 5 giờ hay tuần, nên không có phần trăm theo khung thời gian và không có mốc thời gian reset.

Mỗi lần làm mới DeepSeek, tiện ích:

1. Tìm khóa API lúc chạy ở chế độ chỉ đọc theo đúng thứ tự ưu tiên:
   - Trước hết kiểm tra biến môi trường `DEEPSEEK_API_KEY`.
   - Nếu không có hoặc để rỗng, đọc tệp `~/.codewhale/secrets/secrets.json` (định dạng JSON `{"entries": {"<tên>": "sk-..."}}`), chỉ dùng mục tên `deepseek` (`entries.deepseek`); các mục khác (ví dụ khóa của dịch vụ khác) không bao giờ được đọc hay gửi đi.
   - Nếu cả hai nơi đều không có khóa hợp lệ, tiện ích ghi trạng thái `no-key` (`missing_key`) ngay mà không gọi mạng và **ẩn mục DeepSeek trên thanh trạng thái** thay vì báo lỗi, nên máy không dùng DeepSeek sẽ không thấy gì. Khóa có nhưng bị máy chủ từ chối (HTTP `401`) vẫn báo lỗi `auth` và mục vẫn hiện.
2. Gửi `GET https://api.deepseek.com/user/balance` với header `Authorization: Bearer <key>`, `Accept: application/json` và `User-Agent: ai-quota-bar/0.2.0`.
3. Phân tích `is_available` và mảng `balance_infos` (`currency`, `total_balance`, `granted_balance`, `topped_up_balance`). Các loại tiền tệ được sắp xếp `USD` (`$`) trước, rồi đến `CNY` (`¥`), rồi các loại tiền tệ khác (`<TIỀN_TỆ> <số_tiền>`), định dạng 2 chữ số thập phân (ví dụ `DeepSeek $10.00` hoặc `DeepSeek $10.00 | ¥50.00`).
4. Đánh giá mức cảnh báo và trạng thái hết số dư:
   - Khi `is_available` là `false`, `total_balance` bằng `0` (và không có loại tiền tệ nào còn số dư dương), hoặc máy chủ trả về HTTP `402` (`Insufficient Balance`), thanh trạng thái hiện rõ trạng thái hết số dư (`DeepSeek $0.00 (hết số dư)` hoặc `DeepSeek: hết số dư`) kèm màu nền đỏ mức nghiêm trọng (`statusBarItem.errorBackground`).
   - Khi `total_balance` dương và nhỏ hơn hoặc bằng `aiQuota.deepseekWarningThreshold` (mặc định `2`, miền `0`-`10000`; đặt `0` để tắt cảnh báo số dư thấp), mục thanh trạng thái đổi sang nền vàng mức cảnh báo (`statusBarItem.warningBackground`) và bật thông báo chuyển mức nếu đang bật thông báo.

## 3. Mô hình bảo mật, cam kết và giới hạn đã biết

### 3.1. Mô hình bảo mật và cam kết

- **Chỉ đọc tệp đăng nhập**: Với Claude Code, Codex và DeepSeek, tiện ích CHỈ ĐỌC `.credentials.json`, `auth.json` và `~/.codewhale/secrets/secrets.json` (cùng biến môi trường `DEEPSEEK_API_KEY`). Tiện ích không bao giờ ghi, sửa hay xóa các tệp đó, và không bao giờ tự làm mới (refresh) OAuth token. Với Antigravity, tiện ích hoàn toàn không đọc tệp thông tin đăng nhập nào.
- **Không tự làm mới token và không lặp vòng khi lỗi xác thực hoặc hết số dư**: Khi token hết hạn hoặc bị từ chối (`401`, hoặc `403` do xác thực), tiện ích báo lỗi loại `auth` kèm hướng dẫn mở lại `claude`, `codex` hoặc đặt `DEEPSEEK_API_KEY` / đăng nhập bằng `codewhale`, không thử lại vòng. Tương tự, khi tài khoản DeepSeek hết số dư (`is_available: false` hoặc HTTP `402`) hay bị giới hạn tần suất (`429`), tiện ích hiển thị trạng thái hết số dư / giới hạn tần suất và chờ theo chu kỳ làm mới hoặc thời hạn `Retry-After`, không tự thử lại vòng.
- **Token và khóa API chỉ nằm trong bộ nhớ của lượt gọi**: Access token và khóa API DeepSeek chỉ tồn tại trong bộ nhớ lúc thực hiện yêu cầu HTTP; không bao giờ được ghi vào `state-<id>.json`, kênh nhật ký Output, tooltip, thông báo, danh sách QuickPick hay thông điệp lỗi. Với DeepSeek, nhật ký chỉ ghi nguồn khóa (`env`, `codewhale` hoặc `none`) và mã trạng thái/mã lỗi (`401`, `402`, `missing_key`, ...). Ngoại lệ tầng mạng và nội dung phản hồi lỗi HTTP không được đưa ra giao diện hay nhật ký; mọi lỗi HTTP/xác thực đều dùng thông điệp dịch cố định và đi qua hàm `sanitize`: cắt bỏ mã màu ANSI và ký tự điều khiển, chỉ giữ dòng đầu không rỗng (tối đa 120 hoặc 200 ký tự), che địa chỉ email, thông tin `Bearer`/`Basic`, giá trị các tham số URL nhạy cảm (`token`, `access_token`, `refresh_token`, `id_token`, `key`, `secret`, `password`, `code` và tương tự), các tiền tố token/khóa (`eyJ...`, `ya29.`, `sk-...`), token OAuth (như `sk-ant-oat01-...`), và mọi chuỗi liền từ 24 ký tự chữ, số và ký hiệu `_-./+=` trở lên thành `[đã che]`.
- **Host cố định qua HTTPS, không theo redirect**: Các yêu cầu HTTP trực tiếp chỉ gửi tới ba host cố định `https://api.anthropic.com` (Claude), `https://chatgpt.com` (Codex) và `https://api.deepseek.com` (DeepSeek) với tùy chọn `redirect: 'error'` để không bao giờ gửi nhầm token sang host khác khi có chuyển hướng. Phản hồi đọc theo khối với trần cứng 256 KiB và áp thời gian chờ theo `aiQuota.timeout` bằng `AbortController`.
- **Dự phòng `curl` dùng đường dẫn tuyệt đối trên Windows và truyền cấu hình qua `stdin`**: Khi `fetch` tới Claude gặp mã `403` có `"Request not allowed"`, tiện ích gọi `<%SystemRoot% hoặc C:\Windows>\System32\curl.exe` trên Windows (không tìm `curl.exe` trong thư mục hiện hành hay thư mục người dùng) hoặc `curl` trên macOS/Linux với tham số `['-q', '--config', '-']`, truyền toàn bộ cấu hình và header chứa token qua `stdin`, tuyệt đối không truyền qua tham số dòng lệnh (`argv`).
- **Xử lý giới hạn tần suất (`429` / `Retry-After`)**: Khi gặp mã `429`, tiện ích đọc header `Retry-After` (dạng giây hoặc ngày HTTP), kẹp thời gian chờ trong khoảng từ 60 giây đến 1 giờ (mặc định 60 giây nếu không có `Retry-After`), và lưu mốc `retryAt` vào `state-<id>.json` để mọi cửa sổ VS Code cùng tôn trọng. Trong thời hạn chờ `retryAt`, kể cả làm mới thủ công cũng không gọi lại API mà chỉ ghi một dòng nhật ký (`Đang chờ giới hạn tần suất tới HH:MM.`).
- **Công tắc nhà cung cấp chỉ nhận cài đặt người dùng (`scope: application`)**: Bốn khóa `aiQuota.providers.<id>.enabled` có phạm vi `scope: application`, chỉ áp dụng ở cài đặt người dùng (`Global`). Cấu hình của workspace hoặc thư mục (`.vscode/settings.json` hay tệp `.code-workspace` trong repo) không thể ghi đè—đảm bảo một repo lạ hoặc bên thứ ba không thể tự ý bật lại nhà cung cấp mà bạn đã tắt (việc vốn sẽ kích hoạt đọc tệp đăng nhập cục bộ hoặc chạy `agy`) và không làm vô hiệu hóa lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị`.
- **Không gửi telemetry và cô lập tệp trạng thái**: Tiện ích không gửi telemetry và chỉ ghi vào thư mục lưu trữ riêng do VS Code cấp (`globalStorageUri`): các tệp trạng thái `state-<id>.json`, tệp khóa `state-<id>.lock` và tệp tạm `.tmp` khi ghi nguyên tử (mục 4.7).

### 3.2. Giới hạn đã biết

- **Không tự làm mới token (token Claude Code hết hạn sau vài giờ, Codex sau vài ngày)**: Theo thiết kế, `ai-quota-bar` không bao giờ tự làm mới OAuth token. Access token của Claude Code thường hết hạn sau vài giờ và của Codex sau vài ngày; nếu bạn lâu không mở `claude` hoặc `codex`, mục trên thanh trạng thái sẽ báo `Claude: chưa đăng nhập` hoặc `Codex: chưa đăng nhập` cho tới khi bạn mở lại `claude` hoặc `codex` để CLI tự làm mới phiên đăng nhập.
- **Số dư DeepSeek là tiền tệ (`USD`/`CNY`), không phải phần trăm theo khung thời gian, và khi hết số dư / bị giới hạn tần suất sẽ không thử lại vòng**: Điểm cuối `/user/balance` của DeepSeek trả về số dư tiền còn lại chứ không có phần trăm 5 giờ hay tuần, nên DeepSeek không có thời điểm reset hay đồng hồ đếm ngược. Nếu tài khoản DeepSeek hết số dư (`is_available: false` hoặc HTTP `402`) hay gặp giới hạn tần suất (`429`), thanh trạng thái hiện `DeepSeek $0.00 (hết số dư)` / `DeepSeek: hết số dư` (hoặc lỗi giới hạn tần suất) và tuân theo khoảng lùi / thời hạn chờ `Retry-After` thông thường, không tự thử lại vòng.
- **Chưa hỗ trợ macOS Keychain**: Trên macOS, Claude Code có thể lưu thông tin đăng nhập OAuth trong macOS Keychain thay vì tệp `~/.claude/.credentials.json`. Hiện tại `ai-quota-bar` chỉ đọc tệp `.credentials.json`, `auth.json` và `secrets.json` trên đĩa; nếu trên macOS không có tệp này, nhà cung cấp sẽ báo chưa đăng nhập.
- **Chưa có cấu hình proxy riêng; VS Code cũ (`1.90`-`1.93`) có thể không đưa `fetch` qua `http.proxy`**: Tiện ích chưa có cài đặt proxy riêng và dùng `fetch` toàn cục của Node (cùng `curl` khi dự phòng). Trên các bản VS Code cũ (`1.90`-`1.93`), `fetch` trong extension host có thể không tự động đi qua cấu hình `http.proxy` của VS Code.
- **API usage của Anthropic và ChatGPT không chính thức, có thể thay đổi**: Điểm cuối `/api/oauth/usage` của Anthropic và `/backend-api/wham/usage` của ChatGPT là API nội bộ của công cụ chứ không phải API công khai cố định, nên cấu trúc yêu cầu hoặc phản hồi có thể thay đổi mà không báo trước. Tương tự, định dạng đầu ra lệnh `/usage` của `agy` cũng có thể đổi ở các bản sau.
- **Dự phòng `curl` chỉ kích hoạt khi Claude trả 403 `"Request not allowed"`**: Nhánh gọi `curl` chỉ dùng cho Claude Code và chỉ khi `fetch` nhận mã HTTP `403` có chuỗi `"Request not allowed"` trong thân phản hồi. Các lỗi `403` khác của Claude được coi là lỗi xác thực (`auth`), và Codex không dùng dự phòng `curl`.
- **Chưa kiểm thử trên macOS và Linux**: Tiện ích được phát triển và kiểm chứng trên Windows 11; hành vi thực tế trên macOS và Linux chưa được chạy thử trên máy thật.
- **Chưa đăng trên Visual Studio Marketplace hay Open VSX**: Tiện ích chưa được phát hành lên Visual Studio Marketplace hay Open VSX, và kho GitHub (`https://github.com/XXLC/ai-quota-bar`, đường dẫn giữ chỗ) cũng chưa được tạo.
- **`agy` luôn khởi động các MCP server đã cấu hình ở mỗi lần làm mới**: Theo phép đo trên Windows 11, mỗi lần chạy `agy -p "/usage"` mất khoảng 4 giây và khởi động mọi MCP server bạn đã cấu hình cho `agy` (tất cả đều thoát khi `agy` thoát). `agy` từ chối cờ `--settings '{"mcpServers":{}}'` (`unknown setting "mcpServers"`, mã thoát 1), nên không có cách tắt MCP cho riêng lần chạy `/usage`. `agy` cũng có thể ghi nhật ký hoặc bộ nhớ đệm vào thư mục `~\.gemini`.
- **Chạy ở phía giao diện người dùng (`extensionKind: ["ui"]`)**: Khi dùng Remote SSH, WSL hoặc Dev Container, tiện ích chạy trên máy cục bộ (nơi mở giao diện VS Code) để đọc tệp đăng nhập và chạy `agy` trên máy người dùng. Nếu bạn chỉ đăng nhập Claude Code, Codex hoặc `agy` bên trong máy từ xa hay container mà không có tệp đăng nhập ở máy cục bộ, tiện ích sẽ không đọc được các tệp từ xa đó.
- **Đổi tài khoản**: Số liệu hiển thị là của tài khoản đang đăng nhập ở từng công cụ; khi đổi tài khoản, số liệu sẽ cập nhật ở lần làm mới kế tiếp.

## 4. Sử dụng

### 4.1. Yêu cầu

- VS Code 1.90 trở lên (khuyến nghị 1.94+ nếu máy dùng proxy qua `http.proxy` của VS Code), hoặc Antigravity IDE.
- Đã đăng nhập sẵn ít nhất một trong ba công cụ trên máy chạy VS Code (các nguồn không dùng có thể tắt trong cài đặt):
  - **Claude Code**: đã đăng nhập để có tệp `<CLAUDE_CONFIG_DIR hoặc ~/.claude>/.credentials.json` chứa `claudeAiOauth.accessToken` còn hạn (và có `C:\Windows\System32\curl.exe` trên Windows hoặc `curl` trên `PATH` ở macOS/Linux nếu máy chủ Anthropic chặn dấu vân tay TLS của Node).
  - **Codex**: đã đăng nhập để có tệp `<CODEX_HOME hoặc ~/.codex>/auth.json` chứa `tokens.access_token`.
  - **Antigravity (`agy`)**: đã cài và đăng nhập `agy` CLI (trên Windows phải là tệp `agy.exe`, xem mục 5.4).

Kiểm tra nhanh `agy` trong terminal:

```powershell
agy --version
agy --output-format json -p "/usage"
```

Lệnh thứ hai phải in một dòng JSON có `"status":"SUCCESS"` và `"num_turns":0`.

### 4.2. Đóng gói và cài đặt

Tiện ích chưa được đăng trên Visual Studio Marketplace hay Open VSX, và kho mã nguồn GitHub (`https://github.com/XXLC/ai-quota-bar`, đường dẫn giữ chỗ) hiện cũng chưa tạo.

Đóng gói tệp `.vsix` từ mã nguồn (cần Node.js, và cần mạng nếu máy chưa có sẵn gói `@vscode/vsce@3.6.0` trong bộ nhớ đệm `npx`):

```powershell
# Đường dẫn giữ chỗ (repo GitHub chưa đăng):
# git clone https://github.com/XXLC/ai-quota-bar.git
cd ai-quota-bar
npx @vscode/vsce@3.6.0 package
```

Lệnh tạo ra tệp `ai-quota-bar-0.2.0.vsix`. Dự án không dùng thư viện npm bên ngoài (chỉ dùng `fetch` toàn cục và các mô-đun `node:*` dựng sẵn), nên không cần chạy `npm install` trước khi đóng gói.

Nếu tải tệp `ai-quota-bar-0.2.0.vsix` dựng sẵn từ bản phát hành trong tương lai, hãy đối chiếu mã băm SHA-256 trước khi cài:

```powershell
Get-FileHash ai-quota-bar-0.2.0.vsix -Algorithm SHA256
```

Cài vào VS Code:

```powershell
code --install-extension ai-quota-bar-0.2.0.vsix
```

Cài vào Antigravity IDE (tệp lệnh nằm ở `%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd`; nếu thư mục `bin` đó không có trong `PATH` thì gọi bằng đường dẫn đầy đủ):

```powershell
antigravity-ide --install-extension ai-quota-bar-0.2.0.vsix
```

Hoặc trong giao diện của cả hai ứng dụng: khung Extensions, menu `...`, chọn "Install from VSIX...", rồi chọn tệp `ai-quota-bar-0.2.0.vsix`.

Sau khi cài `ai-quota-bar`, hãy gỡ hoặc tắt `XXLC.agy-quota-bar` và tắt các tiện ích xem quota Claude Code, Codex hoặc Antigravity riêng lẻ để tránh gọi API trùng lặp và tránh hiện hai mục trùng nhau trên thanh trạng thái.

Tiện ích kích hoạt sau khi cửa sổ khởi động xong (`onStartupFinished`), không làm chậm lúc mở cửa sổ, và vẫn hoạt động trong chế độ Restricted Mode (thư mục chưa tin cậy).

### 4.3. Cấu hình

Mở Settings, tìm `aiQuota` (hoặc `aiQuota.providers` để lọc riêng ba công tắc nhà cung cấp). Cấu hình cũ của `XXLC.agy-quota-bar` không tự động chuyển sang. Các cài đặt trên trang Settings của VS Code được sắp theo trường `order` (`1` đến `11`), trong đó ba công tắc bật/tắt nhà cung cấp được đặt lên đầu tiên (`order` `1`-`3`):

| Khóa | Mặc định | Miền giá trị / Kiểu | Ý nghĩa |
|---|---|---|---|
| `aiQuota.providers.claude.enabled` | `true` | `true`/`false` (`scope: application`, `order: 1`) | Hiện quota Claude Code trên thanh trạng thái. Tắt nếu không còn dùng; khi tắt, tiện ích không đọc thông tin đăng nhập của Claude Code và không gọi API. Phạm vi `scope: application` giữ công tắc này ở cài đặt người dùng để cấu hình workspace/repo không thể ghi đè. |
| `aiQuota.providers.codex.enabled` | `true` | `true`/`false` (`scope: application`, `order: 2`) | Hiện quota Codex trên thanh trạng thái. Tắt nếu không còn dùng; khi tắt, tiện ích không đọc thông tin đăng nhập của Codex và không gọi API. Phạm vi `scope: application` giữ công tắc này ở cài đặt người dùng để cấu hình workspace/repo không thể ghi đè. |
| `aiQuota.providers.agy.enabled` | `true` | `true`/`false` (`scope: application`, `order: 3`) | Hiện quota Antigravity trên thanh trạng thái. Tắt nếu không còn dùng; khi tắt, tiện ích không chạy `agy`. Phạm vi `scope: application` giữ công tắc này ở cài đặt người dùng để cấu hình workspace/repo không thể ghi đè. |
| `aiQuota.agyPath` | rỗng | Đường dẫn tệp (`scope: machine`, `order: 4`) | Đường dẫn tuyệt đối đến `agy` (để trống để tự dò trên `PATH` và `%LOCALAPPDATA%\agy\bin\agy.exe`, mục 5.3); Windows chỉ hỗ trợ tệp `.exe`. Phạm vi `scope: machine` ngăn workspace lạ ghi đè đường dẫn thực thi. |
| `aiQuota.refreshInterval` | `300` | `60`-`3600` (giây, `order: 5`) | Khoảng làm mới tự động, tính bằng giây, cho từng provider đang bật. |
| `aiQuota.timeout` | `45` | `5`-`300` (giây, `order: 6`) | Thời gian chờ tối đa (giây) cho một lượt làm mới (gọi HTTP hoặc chạy `agy`). Hết giờ thì hủy yêu cầu HTTP qua `AbortController` hoặc giết `agy` cùng toàn bộ cây tiến trình con. |
| `aiQuota.warningThreshold` | `30` | `0`-`100` (%, `order: 7`) | Ngưỡng cảnh báo phần trăm còn lại (nhỏ hơn hoặc bằng giá trị này là mức cảnh báo). |
| `aiQuota.criticalThreshold` | `10` | `0`-`100` (%, `order: 8`) | Ngưỡng nghiêm trọng phần trăm còn lại (nhỏ hơn hoặc bằng giá trị này là mức nghiêm trọng). Nếu đặt lớn hơn ngưỡng cảnh báo thì dùng bằng ngưỡng cảnh báo. |
| `aiQuota.notificationEnabled` | `true` | `true`/`false` (`order: 9`) | Thông báo khi quota xấu đi hoặc hồi phục (mục 4.6). Khi tắt, tiện ích vẫn theo dõi và lưu mức vào tệp trạng thái nhưng không hiện thông báo; bật lại không phát lại thông báo cũ. |
| `aiQuota.claudeConfigDir` | rỗng | Đường dẫn thư mục (`scope: machine`, `order: 10`) | Thư mục cấu hình Claude chứa `.credentials.json` (rỗng: `CLAUDE_CONFIG_DIR` hoặc `~/.claude`). |
| `aiQuota.codexHome` | rỗng | Đường dẫn thư mục (`scope: machine`, `order: 11`) | Thư mục cấu hình Codex chứa `auth.json` (rỗng: `CODEX_HOME` hoặc `~/.codex`). |

Giá trị số nằm ngoài miền cho phép sẽ được kẹp về biên gần nhất; giá trị không phải số sẽ quay về mặc định. Khi thay đổi `aiQuota.claudeConfigDir`, `aiQuota.codexHome` hoặc `aiQuota.agyPath`, tiện ích sẽ kích hoạt làm mới ngay cho nhà cung cấp tương ứng (nếu đang bật).

**Cách tắt một nhà cung cấp khi không còn dùng (và hành vi khi tắt):**

- Chạy lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị` (`aiQuota.selectProviders` — cũng có sẵn trong danh sách QuickPick của `AI Quota Bar: Xem chi tiết`) để đánh dấu hoặc bỏ đánh dấu `Claude Code`, `Codex`, `Antigravity`, hoặc bật/tắt trực tiếp ba công tắc `aiQuota.providers.<id>.enabled` ở đầu trang Settings (`aiQuota.providers`). Vì cả ba công tắc đều có `scope: application`, chúng chỉ lưu ở cài đặt người dùng (`Global`); một workspace hoặc repo (`.vscode/settings.json` hay `.code-workspace`) không thể ghi đè để tự ý bật lại việc đọc thông tin đăng nhập hay gọi API/CLI ngoài ý muốn của bạn.
- Khi tắt một nhà cung cấp (`false`), mục thanh trạng thái của nhà cung cấp đó bị hủy ngay. Nếu một lượt làm mới của nhà cung cấp đó đang chạy dở, yêu cầu HTTP đang chờ bị hủy (`AbortController`) hoặc cây tiến trình `agy` bị kết thúc, khóa lease `runningSince` được trả lại, và mọi dòng nhật ký thành công hay thông báo từ thao tác ghi trạng thái đang hoàn tất dở đều bị chặn lại. Trong suốt thời gian tắt, tiện ích không đọc tệp thông tin đăng nhập (`.credentials.json` hoặc `auth.json`), không gọi API usage và không chạy `agy` (cả ở nhịp tự động, lệnh làm mới thủ công lẫn khi đổi đường dẫn cấu hình).
- Tệp trạng thái dùng chung của nhà cung cấp đó (`state-<id>.json`, gồm dữ liệu đệm, mốc thời gian, mức cảnh báo đã thông báo, số lỗi liên tiếp và hạn chờ `retryAt` nếu có) được giữ nguyên trên đĩa. Khi bật lại (`true`), mỗi cửa sổ đang mở tạo lại mục thanh trạng thái và chạy kiểm tra làm mới theo cơ chế lease thông thường (`refresh(false)`): nếu dữ liệu trong `state-<id>.json` vẫn còn mới hoặc nhà cung cấp đang trong khoảng lùi sau lỗi / thời hạn chờ `retryAt`, tiện ích hiển thị ngay trạng thái chung mà không đọc tệp đăng nhập, không gọi API, không chạy `agy` và không xóa bộ đếm lỗi liên tiếp (`consecutiveErrors`); nếu đã đến hạn làm mới khi đang mở nhiều cửa sổ, khóa lease `runningSince` bảo đảm chỉ một cửa sổ gọi API hoặc chạy `agy` chứ không phải mọi cửa sổ cùng lúc, còn các cửa sổ khác đọc kết quả từ tệp trạng thái chung. Bạn có thể chạy lệnh `AI Quota Bar: Làm mới quota` bất cứ lúc nào nếu muốn ép làm mới thủ công ngay.
- Nếu tắt cả ba nhà cung cấp, thanh trạng thái sẽ trống (không tạo mục thanh trạng thái giả). Bạn có thể bật lại bất cứ lúc nào từ Command Palette bằng lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị` (`aiQuota.selectProviders`) hoặc `AI Quota Bar: Xem chi tiết` (`aiQuota.showDetails`), hoặc trong Settings (`aiQuota.providers`).

### 4.4. Lệnh

Mở Command Palette (`Ctrl+Shift+P`), gõ `AI Quota Bar` (mã lệnh bắt đầu bằng `aiQuota.`):

| Mã lệnh | Tên lệnh | Tác dụng |
|---|---|---|
| `aiQuota.refresh` | AI Quota Bar: Làm mới quota | Làm mới ngay tất cả các provider đang bật, kể cả khi dữ liệu còn mới hoặc cửa sổ khác đang chạy, đồng thời đưa số lỗi liên tiếp về 0 (hết giãn khoảng làm mới theo lũy thừa). Nếu một provider đang trong thời hạn chờ `429` (`Retry-After`), lệnh không gọi API sớm mà chỉ ghi nhật ký `Đang chờ giới hạn tần suất tới HH:MM.`. Nếu chính cửa sổ này đang làm mới một provider thì chờ lượt đó xong. Nếu không lấy được khóa tệp trạng thái của một provider sau 5 lần thử thì bỏ qua provider đó và ghi cảnh báo vào nhật ký. |
| `aiQuota.showDetails` | AI Quota Bar: Xem chi tiết | Mở danh sách QuickPick gộp (tiêu đề `AI Quota Bar`) gồm mọi giới hạn của các provider đang bật, chia theo từng provider bằng dòng phân cách (`Claude Code`, `Codex`, `Antigravity`), ngay dưới mỗi tiêu đề nhà cung cấp có dòng `cập nhật HH:MM` (hoặc dòng `Chưa bật nhà cung cấp nào.` khi đã tắt cả ba), và cuối danh sách có bốn thao tác `$(refresh) Làm mới ngay` (làm mới tất cả các provider đang bật), `$(output) Mở nhật ký`, `Chọn nhà cung cấp hiển thị` (gọi `aiQuota.selectProviders`) và `Mở cài đặt` (mở trang Settings lọc theo `aiQuota.providers`). Bấm vào bất kỳ mục nào trên thanh trạng thái cũng mở cùng danh sách gộp này. |
| `aiQuota.showLog` | AI Quota Bar: Mở nhật ký | Mở kênh Output dùng chung "AI Quota Bar". |
| `aiQuota.selectProviders` | AI Quota Bar: Chọn nhà cung cấp hiển thị | Mở danh sách QuickPick chọn nhiều mục (`canPickMany`, tiêu đề `Chọn nhà cung cấp hiển thị`, dòng nhắc `Chọn nhà cung cấp hiển thị trên thanh trạng thái`) gồm `Claude Code` (`API Claude Code`), `Codex` (`API Codex`) và `Antigravity` (`agy /usage`), đánh dấu sẵn theo cấu hình đang bật. Khi xác nhận, lệnh chỉ ghi các khóa `aiQuota.providers.<id>.enabled` có thay đổi vào cài đặt người dùng (`Global`); nhấn `Esc` hoặc giữ nguyên lựa chọn không ghi cấu hình. Nếu việc ghi cài đặt người dùng gặp lỗi giữa chừng (chẳng hạn `settings.json` có lỗi cú pháp), tiện ích giữ nguyên các khóa đã ghi thành công trước đó, ghi lỗi đã làm sạch vào kênh Output và hiện thông báo lỗi rõ ràng (`Không cập nhật được cấu hình nhà cung cấp. Các khóa đã ghi: <danh sách khóa hoặc không có>. Lỗi: <lỗi>`). Sau vòng ghi, lệnh đọc lại cấu hình hiệu lực và chỉ khi cả ba nhà cung cấp đều thực sự đang tắt mới hiện thông báo hướng dẫn bật lại bằng lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị` hoặc Cài đặt (`aiQuota.providers`). |

### 4.5. Đọc thanh trạng thái, tooltip và danh sách chi tiết gộp

Mỗi provider đang bật có một mục `StatusBarItem` riêng ở bên phải thanh trạng thái với mã định danh (`id`) và tên hiển thị (`name`) riêng, xếp từ trái sang phải theo độ ưu tiên (`100`, `99`, `98`):

1. **Claude Code** (`id: "aiQuota.claude"`, `name: "Claude Code"`, ưu tiên `100`, bên trái nhất): `Claude 84% | 29%`
2. **Codex** (`id: "aiQuota.codex"`, `name: "Codex"`, ưu tiên `99`, ở giữa): `Codex 76% | 96%`
3. **Antigravity** (`id: "aiQuota.agy"`, `name: "Antigravity"`, ưu tiên `98`, bên phải nhất): `Gemini 91% | 60% · Claude/GPT 80% | 55%`

Nhờ mỗi mục có `StatusBarItem` ID riêng, bạn có thể bấm chuột phải vào thanh trạng thái của VS Code để ẩn hoặc hiện từng mục `Claude Code`, `Codex`, `Antigravity` độc lập. Việc ẩn mục qua menu chuột phải của thanh trạng thái chỉ ẩn phần tử giao diện; nếu không còn dùng một nhà cung cấp và muốn ngừng hẳn việc đọc thông tin đăng nhập, gọi API hoặc chạy `agy` (đồng thời gỡ mục trên thanh trạng thái), hãy tắt qua lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị` (`aiQuota.selectProviders`) hoặc đặt `aiQuota.providers.<id>.enabled` thành `false` trong Settings (mục 4.3).

Quy tắc hiển thị trên từng mục thanh trạng thái:

- Mỗi nhóm trong một provider hiển thị dạng `<nhãn nhóm> <5h>% | <weekly>%`, trong đó số đầu là cửa sổ 5 giờ (`windowKey === '5h'`) và số sau là cửa sổ tuần (`windowKey === 'weekly'`), ví dụ `Claude 84% | 29%` hoặc `Codex 76% | 96%`. Khi trong cùng một nhóm có nhiều bucket trùng loại cửa sổ (`5h` hoặc `weekly`), thanh trạng thái lấy bucket có phần trăm còn lại (`percent`) thấp nhất, còn toàn bộ các bucket vẫn được giữ đầy đủ trong tooltip và danh sách QuickPick.
- Khi một provider có nhiều nhóm (Antigravity có hai nhóm `Gemini` và `Claude/GPT`), các nhóm được ngăn cách bằng ` · ` (dấu chấm giữa, `U+00B7`) để không lẫn với dấu `|` tách giữa 5 giờ và tuần, ví dụ `Gemini 91% | 60% · Claude/GPT 80% | 55%`.
- Nếu thiếu cửa sổ 5 giờ hoặc cửa sổ tuần, vị trí bị thiếu hiện `--` (ví dụ `Codex 76% | --` hoặc `Codex -- | 96%`).
- Các giới hạn phụ (`other:*`, như cửa sổ tuần theo từng model của Claude, khung thời gian tùy chỉnh như 3 ngày của Codex, hoặc cửa sổ thiếu `limit_window_seconds`) được hiển thị trên thanh trạng thái theo quy tắc:
  - Khi nhóm có **đủ** cả hai cửa sổ `5h` và `weekly`, các giới hạn `other:*` ở mức bình thường (`ok`) hoặc đã qua giờ reset (`unknown`) được ẩn trên thanh trạng thái và chỉ nối thêm khi có ít nhất một giới hạn `other:*` ở mức cảnh báo (`warning`) hoặc nghiêm trọng (`critical`).
  - Khi nhóm bị **thiếu** cửa sổ `5h` hoặc `weekly`, giới hạn `other:*` luôn được nối thêm kể cả khi ở mức bình thường (`ok`) hoặc đã qua giờ reset (`?%`), dưới dạng ` | <nhãn> <giá trị>` (ví dụ `Codex 80% | -- | 3 ngày 60%`), để giới hạn phụ không bị che khuất sau dấu `--`.
  - Khi nhóm **không có** cả `5h` lẫn `weekly` (chỉ có các giới hạn `other:*`), nhóm hiển thị kèm nhãn cửa sổ dưới dạng `<nhãn nhóm> <nhãn> <giá trị>` (ví dụ `Codex Giới hạn 60%`).
  - Trong mọi trường hợp trên thanh trạng thái, mỗi nhóm chỉ nối **tối đa một** giới hạn `other:*`: giới hạn có phần trăm còn lại thấp nhất trong các giới hạn `other:*` ứng viên chưa qua giờ reset (hoặc hiện `?%` nếu mọi ứng viên đều đã qua giờ reset). Nhãn của giới hạn phụ trên thanh trạng thái được rút gọn tối đa **16 ký tự Unicode** (code point; nếu dài hơn 16 ký tự thì lấy 15 ký tự đầu kèm dấu `…`, `U+2026`). Nếu nhóm có nhiều hơn một giới hạn `other:*`, thanh trạng thái nối thêm ` +N` (với `N` là số giới hạn `other:*` còn lại trong nhóm) ngay sau phần trăm (ví dụ `Claude 90% | 50% | Claude Opus 4.5… 5% +2` hoặc `Codex Giới hạn 60% +1`). Tooltip và danh sách QuickPick luôn giữ toàn bộ các giới hạn với nhãn đầy đủ không cắt ngắn.
- Mỗi lần vẽ lại (`render`), từng mục thanh trạng thái đều cập nhật nhãn trợ năng `accessibilityInformation.label` cho trình đọc màn hình (như NVDA hoặc Narrator): mỗi nhóm được đọc rõ dạng `<nhãn nhóm>: 5 giờ <5h>, Tuần <weekly>` ở tiếng Việt hoặc `<group label>: 5-hour <5h>, Weekly <weekly>` ở tiếng Anh (ví dụ `Claude: 5 giờ 84%, Tuần 29%`), nối tiếp bằng các giới hạn `other:*` với nhãn đầy đủ (`, <nhãn cửa sổ> <giá trị>`), và ngăn cách nhiều nhóm bằng `; `. Cửa sổ bị thiếu được đọc là `không có` (`not available` ở tiếng Anh), giới hạn đã qua giờ reset (`?%`) được đọc là `chưa rõ` (`unknown` ở tiếng Anh), và các ký hiệu codicon (`$(...)`) được loại bỏ khỏi nhãn đọc khi đang tải hoặc báo lỗi.
- Phần trăm luôn làm tròn xuống (`9,9%` hiện `9%`), phần trăm đã dùng `> 100` được coi là đã hết (`0%` còn lại, mức nghiêm trọng), và ngưỡng cảnh báo/nghiêm trọng được so với đúng số nguyên đang hiện.
- Giới hạn đã qua giờ reset (mức `unknown`) hiện `?%` tại đúng vị trí của cửa sổ đó trên thanh cho tới lần làm mới tiếp theo (và nếu nhóm chỉ có `other:*` mà mọi giới hạn đều đã qua giờ reset thì nhóm hiện `?%` kèm nhãn cửa sổ). Giới hạn đã qua giờ reset không làm đổi màu nền.
- Màu nền (`severity`) được tính độc lập cho từng mục thanh trạng thái theo mức xấu nhất trong tất cả các giới hạn chưa qua giờ reset của các nhóm thuộc mục đó (kể cả giới hạn `other:*`): vàng (`statusBarItem.warningBackground`) ở mức cảnh báo, đỏ (`statusBarItem.errorBackground`) ở mức nghiêm trọng.
- Khi một provider chưa đăng nhập hoặc token đã hết hạn (lỗi `auth`), mục của provider đó hiện `Claude: chưa đăng nhập` hoặc `Codex: chưa đăng nhập` (kèm biểu tượng `$(error)` khi chưa có dữ liệu đệm, hoặc `$(history)` khi vẫn còn bảng dữ liệu cũ trong tooltip) và đưa màu nền của mục về bình thường (`ok`), trong khi các mục khác vẫn hoạt động bình thường.

Ví dụ chữ trên một mục thanh trạng thái:

| Tình huống | Chữ trên thanh (ví dụ) |
|---|---|
| Hiển thị chuẩn `5h \| weekly` (Claude / Codex / Antigravity) | `Claude 84% \| 29%` / `Codex 76% \| 96%` / `Gemini 91% \| 60% · Claude/GPT 80% \| 55%` |
| Thiếu cửa sổ 5 giờ hoặc cửa sổ tuần (không có `other:*` / có `other:*`) | `Codex 76% \| --` / `Codex 80% \| -- \| 3 ngày 60%` |
| Chỉ có giới hạn `other:*` (không có `5h` và `weekly`) | `Codex Giới hạn 60%` / `Codex Giới hạn 60% +1` |
| Giới hạn tuần ở mức nghiêm trọng | `Claude 72% \| 8%` (nền đỏ với ngưỡng mặc định) |
| Giới hạn theo model hoặc tùy chỉnh (`other:*`) ở mức cảnh báo/nghiêm trọng (có cắt nhãn và `+N`) | `Claude 84% \| 55% \| Sonnet 4.5 20%` / `Claude 90% \| 50% \| Claude Opus 4.5… 5% +2` |
| Phần trăm đã dùng >= 100% (đã hết quota) | `Codex 0% \| 96%` (nền đỏ với ngưỡng mặc định) |
| Giới hạn đã qua giờ reset, chờ làm mới | `Gemini ?% \| 60% · Claude/GPT 80% \| 55%` (`?%` không tô màu) |
| Đang làm mới thủ công | thêm `$(sync~spin)` ở đầu |
| Dữ liệu cũ | `$(history) Claude 84% \| 29%` |
| Chưa đăng nhập / token hết hạn (chưa có dữ liệu đệm / còn dữ liệu đệm) | `$(error) Claude: chưa đăng nhập` / `$(history) Claude: chưa đăng nhập` |
| Không tìm thấy tệp thực thi `agy` | `$(error) Antigravity: không tìm thấy agy` |
| Lỗi khác của nhà cung cấp (chưa có dữ liệu đệm) | `$(error) Claude: lỗi` / `$(error) Codex: lỗi` / `$(error) Antigravity: lỗi` |

(`$(...)` là biểu tượng codicon của VS Code; dấu `\|` trong bảng là ký tự `|` trên thanh, và `·` là dấu chấm giữa `U+00B7` ngăn cách các nhóm.)

Di chuột lên từng mục để xem tooltip riêng của provider đó. Tooltip được trình bày dưới dạng bảng Markdown có tiêu đề theo provider (`**Quota Claude Code**`, `**Quota Codex**` hoặc `**Quota Antigravity**`), các cột `Nhóm | Giới hạn | Còn lại | Reset lúc | Còn`, thời điểm cập nhật gần nhất và ngưỡng đang áp dụng:

```
Quota Claude Code

| Nhóm   | Giới hạn   | Còn lại           | Reset lúc      | Còn           |
|--------|------------|-------------------|----------------|---------------|
| Claude | 5 giờ      | 72%               | 04:00 T3 03/11 | 3 giờ 39 phút |
| Claude | Tuần       | 8% (nghiêm trọng) | 00:00 T2 09/11 | 5 ngày 23 giờ |
| Claude | Sonnet 4.5 | 45%               | 00:00 T2 09/11 | 5 ngày 23 giờ |

Cập nhật lúc 00:21 (vừa xong). Ngưỡng: cảnh báo <= 30%, nghiêm trọng <= 10%.

Bấm để xem chi tiết.
```

- Ô ở mức cảnh báo có thêm chữ `(cảnh báo)`; ô ở mức nghiêm trọng có `(nghiêm trọng)` và được in đậm.
- "Reset lúc" là giờ địa phương dạng `giờ:phút thứ ngày/tháng` (CN, T2 ... T7), ví dụ `04:00 T3 03/11` (mục 4.10).
- "Còn" là thời gian đếm ngược tới lúc reset: `X ngày Y giờ`, `X giờ Y phút`, `Y phút`, `dưới 1 phút`, hoặc `đã đến giờ reset`. Nếu không có giờ reset thì cả hai cột hiện `không rõ`.
- Khi dữ liệu cũ, dưới dòng tiêu đề có dòng bắt đầu bằng biểu tượng `$(history)` và chữ in đậm `Dữ liệu cũ.`, kèm lý do (`Lần làm mới lúc HH:MM thất bại: <lỗi>` hoặc `Đã quá thời hạn cập nhật.`).
- Ký tự đặc biệt Markdown và các chuỗi URL trần (`://`, `www.`) trong nhãn đều được thoát để ngăn tự động tạo liên kết hoặc chèn định dạng vào tooltip.
- Thanh trạng thái và tooltip của mọi provider được vẽ lại mỗi 60 giây để thời gian đếm ngược luôn chính xác giữa các lần làm mới.

Bấm vào bất kỳ mục nào trong ba mục trên thanh trạng thái (hoặc chạy lệnh `AI Quota Bar: Xem chi tiết`) sẽ mở **danh sách QuickPick gộp**:

- Ngay dưới dòng phân cách (separator) của từng nhà cung cấp đang bật (`Claude Code`, `Codex`, `Antigravity`) là một dòng thông tin không hành động ghi `cập nhật HH:MM` (hoặc `cập nhật chưa có`, kèm `(dữ liệu cũ)` nếu dữ liệu đã cũ).
- Tiếp theo là danh sách các giới hạn của nhà cung cấp đó (có biểu tượng `$(warning)` hoặc `$(error)` ở các giới hạn thấp; với nhà cung cấp có nhiều nhóm như Antigravity thì nhãn mỗi dòng có thêm tên nhóm ở đầu, ví dụ `Gemini 5 giờ: 91%`), hoặc dòng `$(error)` nếu chưa có dữ liệu đệm.
- Nếu đã tắt cả ba nhà cung cấp, danh sách hiện dòng `Chưa bật nhà cung cấp nào.` ở phía trên dòng phân cách hành động.
- Cuối danh sách (sau một dòng phân cách) là bốn thao tác, luôn xuất hiện kể cả khi chưa bật nhà cung cấp nào: `$(refresh) Làm mới ngay` (làm mới tất cả các provider đang bật), `$(output) Mở nhật ký`, `Chọn nhà cung cấp hiển thị` (chạy lệnh `aiQuota.selectProviders`) và `Mở cài đặt` (mở trang Settings với truy vấn `aiQuota.providers`).

### 4.6. Thông báo

Mỗi provider lưu mức (`ok`, `warning`, `critical`) của từng giới hạn trong tệp `state-<id>.json` riêng (khóa mức có dạng `<provider>|<groupName>|<windowKey>` để các nhóm giữa các provider không bao giờ đè lên nhau), giữ qua các lần khởi động lại VS Code, và chỉ bật thông báo khi mức thay đổi:

| Mức trước | Mức mới | Thông báo |
|---|---|---|
| (chưa có) | bình thường | Không |
| (chưa có) | cảnh báo hoặc nghiêm trọng | Có, một lần |
| bình thường | cảnh báo | Có (cảnh báo) |
| bình thường hoặc cảnh báo | nghiêm trọng | Có (lỗi) |
| nghiêm trọng | cảnh báo | Không |
| cảnh báo hoặc nghiêm trọng | bình thường | Có (đã hồi phục) |
| giữ nguyên | giữ nguyên | Không |

- Các thay đổi mức trong một lượt làm mới được gộp chung kèm tiền tố tên provider (`Claude Code: ...`, `Codex: ...`, `Antigravity: ...`) và hiển thị theo mức độ nghiêm trọng cao nhất.
- Chỉ cửa sổ vừa trực tiếp thực hiện lượt làm mới cho provider đó mới bật thông báo, sau khi đã lưu mức mới vào tệp trạng thái dùng chung; các cửa sổ khác chỉ cập nhật thanh trạng thái.
- Giới hạn đã qua giờ reset (`?%`) không làm đổi mức. Giới hạn biến mất khỏi phản hồi sẽ được bỏ qua mà không bật thông báo.
- Khi không tìm thấy `agy` (và `aiQuota.providers.agy.enabled` đang bật), tiện ích hiện tối đa một thông báo lỗi mỗi lần kích hoạt trong cửa sổ, kèm nút "Mở cài đặt" trỏ tới `aiQuota.agyPath`.
- Các lỗi khác (như chưa đăng nhập Claude/Codex, token hết hạn, giới hạn tần suất `429`, lỗi mạng hoặc hết thời gian chờ) chỉ hiển thị trên thanh trạng thái, tooltip, QuickPick và nhật ký, không bật thông báo.

### 4.7. Nhiều cửa sổ

Mọi cửa sổ của cùng một ứng dụng dùng chung thư mục `globalStorageUri` của tiện ích, nhưng tách tệp riêng cho từng provider (`<id>` là `claude`, `codex` hoặc `agy`):

- `state-<id>.json`: kết quả làm mới gần nhất, thời điểm thử và thành công gần nhất, lỗi gần nhất, số lỗi liên tiếp, thời hạn chờ `retryAt` (sau lỗi HTTP `429`), các mức đã thông báo và dấu "đang chạy" (`runningSince`) của riêng provider đó.
- `state-<id>.lock`: tệp khóa độc quyền chỉ giữ trong vài mili giây khi đọc-ghi `state-<id>.json` (không giữ khóa trong lúc chờ yêu cầu HTTP hay tiến trình `agy`). Nếu khóa bận, tiện ích thử tối đa 5 lượt (chờ 50, 100, 200, 400 ms). Khóa cũ hơn 30 giây được coi là khóa mồ côi, đổi sang tên `.old` duy nhất rồi xóa.
- `state-<id>.json.<pid>.<uuid>.tmp`: tệp tạm được ghi và đổi tên nguyên tử thành `state-<id>.json`.

Nhờ đặt tên `state-<id>.json` thay vì `state.json`, `ai-quota-bar` không bao giờ giẫm lên tệp trạng thái của `agy-quota-bar`.

Mỗi 60 giây (cũng như khi bật hoặc bật lại một nhà cung cấp), từng cửa sổ kiểm tra từng provider đang bật dưới khóa riêng của provider đó (với dung sai 5 giây trên `refreshInterval` để nhịp 60 giây không làm trễ thêm một phút mỗi chu kỳ). Vì quyết định làm mới, kiểm tra `retryAt` và việc ghi dấu `runningSince` nằm trong cùng một lần giữ khóa, mở nhiều cửa sổ VS Code—hoặc bật lại một nhà cung cấp khi đang mở nhiều cửa sổ—vẫn chỉ sinh ra một lượt gọi API hoặc chạy `agy` cho mỗi provider trong mỗi chu kỳ và dùng chung thời hạn chờ `429` (`Retry-After`) giữa mọi cửa sổ. Nếu một cửa sổ không lưu được kết quả `429` do khóa bận cả 5 lần thử, cửa sổ đó vẫn giữ thời hạn chờ cục bộ để không gọi lại sớm, đồng thời vẫn đọc `state-<id>.json` để nhận kết quả mới hơn nếu cửa sổ khác cập nhật thành công. Nếu đóng hoặc tải lại cửa sổ khi một lượt làm mới đang chạy, tiện ích hủy yêu cầu HTTP (hoặc giết cây tiến trình `agy` trong tối đa 2,5 giây), gỡ dấu `runningSince` và khôi phục thời điểm thử trước đó để cửa sổ khác có thể tiếp nhận khi đến hạn.

### 4.8. Sau khi máy ngủ hoặc ngủ đông

- Mỗi 60 giây tiện ích kiểm tra hạn làm mới của từng provider, nên trong vòng khoảng 60 giây sau khi máy thức dậy, các provider quá hạn sẽ tự động được làm mới.
- Khi một giới hạn vừa bước qua thời điểm reset mà lần thử gần nhất diễn ra trước mốc đó, tiện ích cũng kích hoạt đúng một lần làm mới cho provider đó (sau khi hết hạn chờ `retryAt` nếu có), kể cả khi đang giãn khoảng làm mới do lỗi.
- Dữ liệu cũ hơn `2 * refreshInterval` (hoặc có lỗi ở lần làm mới gần nhất) được gắn biểu tượng `$(history)` (dữ liệu cũ) và vẫn giữ trên thanh để tham khảo cho tới khi làm mới thành công.
- Đồng hồ hệ thống bị lùi về trước `lastAttemptAt` sẽ kích hoạt làm mới, và mọi mốc `retryAt` vượt quá thời điểm hiện tại hơn 1 giờ đều bị loại bỏ để việc lùi đồng hồ không làm khóa cứng nhà cung cấp.

### 4.9. Nhật ký

Kênh Output dùng chung **AI Quota Bar** ghi lại mọi lượt làm mới của tất cả các provider đang bật, mỗi dòng đều có tiền tố `[Claude Code]`, `[Codex]` hoặc `[Antigravity]`:

- Lần làm mới thành công:
  - Claude Code / Codex: `Làm mới: thành công, <N> mốc hợp lệ.`
  - Antigravity (`agy`): `Làm mới: thành công, <ms> ms, <N> mốc hợp lệ, mã thoát <code>, nguồn: agy`
  - Lấy từ bộ nhớ đệm của cửa sổ khác: `Làm mới: nguồn: bộ nhớ đệm (cửa sổ khác, <age> giây trước).`
- Lần làm mới thất bại: `Làm mới: lỗi <loại>, <thông điệp>` với `<loại>` là `auth`, `network`, `http`, `not-found`, `timeout`, `exit`, `spawn` hoặc `unexpected`, và `<thông điệp>` đã qua `sanitize`.
- Bỏ qua làm mới thủ công khi đang trong thời hạn chờ `429`: `Đang chờ giới hạn tần suất tới HH:MM.`
- Các cảnh báo khi khóa bận, không ghi được tệp trạng thái, hoặc không giết được cây tiến trình.

Nhật ký lần thành công không bao giờ ghi nội dung phản hồi HTTP thô hay đầu ra thô của `agy`. Mọi thông điệp lỗi đều đi qua `sanitize` (mục 3.1) trước khi ghi vào nhật ký.

### 4.10. Ngôn ngữ

Giao diện mặc định là tiếng Anh, và tự chuyển sang tiếng Việt khi ngôn ngữ hiển thị của VS Code là tiếng Việt (`vi` hoặc `vi-*` trong `vscode.env.language`, chọn lúc kích hoạt tiện ích). Sau khi đổi ngôn ngữ hiển thị của VS Code, cần khởi động lại VS Code để áp dụng.

Định dạng giờ reset: tiếng Anh `Tue 03 Nov 02:48`, tiếng Việt `02:48 T3 03/11`.

## 5. Khắc phục sự cố

Bước đầu tiên cho mọi sự cố: chạy lệnh `AI Quota Bar: Mở nhật ký` (`aiQuota.showLog`) để xem dòng nhật ký có tiền tố `[Claude Code]`, `[Codex]` và `[Antigravity]`.

Giãn khoảng làm mới khi lỗi lặp lại và thời hạn chờ `429` (`Retry-After`):

- Từ lần lỗi liên tiếp thứ 3 của một provider, khoảng làm mới của riêng provider đó tự nhân đôi sau mỗi lỗi (ví dụ với mặc định 300 giây: 600, 1 200, 2 400 giây), tối đa 3 600 giây. Một lần làm mới thành công, hoặc lệnh `AI Quota Bar: Làm mới quota`, sẽ đưa số lỗi liên tiếp về 0.
- Với phản hồi HTTP `429` từ Claude hoặc Codex, tiện ích áp dụng header `Retry-After` của máy chủ được kẹp trong khoảng 60 giây đến 1 giờ (hoặc 60 giây nếu không có header) và lưu `retryAt` vào `state-<id>.json` dùng chung cho mọi cửa sổ. Trong thời hạn chờ `retryAt`, làm mới thủ công không gọi lại API mà chỉ ghi vào nhật ký dòng `Đang chờ giới hạn tần suất tới HH:MM.`.

### 5.1. Claude Code hoặc Codex: chưa đăng nhập hoặc token hết hạn (lỗi `auth`)

Dấu hiệu: mục Claude hoặc Codex trên thanh trạng thái hiện `Claude: chưa đăng nhập` hoặc `Codex: chưa đăng nhập`, và tooltip, QuickPick hoặc nhật ký ghi `Chưa đăng nhập hoặc thông tin đăng nhập đã hết hạn. Mở claude/codex để đăng nhập lại.`.

Nguyên nhân:

- Tệp thông tin đăng nhập (`~/.claude/.credentials.json` hoặc `~/.codex/auth.json`, hoặc đường dẫn trong `aiQuota.claudeConfigDir` / `aiQuota.codexHome`) chưa tồn tại hoặc không có trường access token.
- OAuth access token đã lưu bị hết hạn cục bộ (`claudeAiOauth.expiresAt` hoặc `exp` của JWT) hoặc bị máy chủ từ chối (`401`, hoặc `403` do xác thực). Vì token của Claude Code thường hết hạn sau vài giờ và của Codex sau vài ngày—đồng thời `ai-quota-bar` không bao giờ tự làm mới token—trạng thái này sẽ xuất hiện khi bạn lâu không mở `claude` hoặc `codex`.
- Trên macOS, Claude Code lưu thông tin đăng nhập trong macOS Keychain thay vì tệp `~/.claude/.credentials.json` (hiện chưa hỗ trợ Keychain).

Cách xử lý:

1. Mở terminal và chạy `claude` (cho Claude Code) hoặc `codex` (cho Codex) để CLI tự làm mới token hoặc yêu cầu đăng nhập lại.
2. Nếu bạn đặt thư mục cấu hình ở vị trí tùy chỉnh, hãy cấu hình `aiQuota.claudeConfigDir` hoặc `aiQuota.codexHome` trong cài đặt người dùng cho khớp.
3. Chạy lệnh `AI Quota Bar: Làm mới quota`.
4. Nếu không còn dùng Claude Code hoặc Codex trên máy này, hãy tắt bằng lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị` (`aiQuota.selectProviders`) hoặc đặt `aiQuota.providers.claude.enabled` hay `aiQuota.providers.codex.enabled` thành `false` trong Settings để tiện ích hủy mục thanh trạng thái và ngừng đọc thông tin đăng nhập cũng như ngừng gọi API của nguồn đó.

### 5.2. Claude Code: lỗi HTTP 403 do chặn dấu vân tay TLS và dự phòng `curl`

Máy chủ biên của Anthropic có thể từ chối bắt tay TLS từ `fetch` của Node bằng mã HTTP `403` kèm nội dung `"Request not allowed"`. Chỉ trong trường hợp đó, `ai-quota-bar` mới tự động chuyển sang gọi `<%SystemRoot% hoặc C:\Windows>\System32\curl.exe` trên Windows (hoặc `curl` trên macOS/Linux) với cấu hình truyền qua `stdin` (`-q --config -`). Nếu máy thiếu `curl` hoặc bị phần mềm bảo mật chặn, bước dự phòng sẽ báo lỗi mạng; hãy kiểm tra tệp thực thi `curl` của hệ thống có chạy được và kết nối được tới `https://api.anthropic.com` hay không.

### 5.3. Antigravity: không tìm thấy `agy`

Dấu hiệu: mục Antigravity hiện `$(error) Antigravity: không tìm thấy agy`, kèm một thông báo lỗi có nút "Mở cài đặt" (tối đa một lần mỗi phiên kích hoạt).

- Nếu `aiQuota.agyPath` có giá trị, tiện ích chỉ kiểm tra đúng đường dẫn đó (phải là đường dẫn tuyệt đối tới tệp đang tồn tại, trên Windows phải có đuôi `.exe`).
- Nếu `aiQuota.agyPath` để rỗng, tiện ích tìm lần lượt trên `PATH` (`agy.exe` trên Windows, `agy` trên macOS/Linux) rồi đến `%LOCALAPPDATA%\agy\bin\agy.exe` (trên Windows).

Cách xử lý: kiểm tra `agy --version` trong terminal, điền đường dẫn tuyệt đối của `agy.exe` vào `aiQuota.agyPath`, hoặc tắt Antigravity bằng lệnh `AI Quota Bar: Chọn nhà cung cấp hiển thị` (`aiQuota.selectProviders`) hay đặt `aiQuota.providers.agy.enabled` thành `false` trong Settings nếu bạn không còn dùng Antigravity (để tiện ích ngừng chạy `agy`).

### 5.4. Không hỗ trợ tệp `.cmd` và `.bat` trên Windows cho `agyPath`

Trên Windows, `aiQuota.agyPath` chỉ chấp nhận tệp `.exe` vì tiện ích khởi chạy `agy` trực tiếp không qua shell (nhằm tránh lỗi chèn lệnh và tránh nhấp nháy cửa sổ console). Hãy trỏ `aiQuota.agyPath` tới chính tệp `agy.exe` (thường ở `%LOCALAPPDATA%\agy\bin\agy.exe`), không trỏ tới script `.cmd` bọc ngoài.

## 6. Tình trạng kiểm chứng

Tiện ích này tổng quát hóa `XXLC.agy-quota-bar` (vốn đã có 174 kiểm thử tự động đạt và số liệu đo `agy` thật trên Windows 11 với `agy` 1.4.12) để bổ sung thêm các nguồn Claude Code, Codex và DeepSeek. Bộ kiểm thử hiện có 363 kiểm thử tự động đạt trên toàn bộ `test/*.test.js`.

Kiểm thử tự động:

```powershell
npm test
```

Chạy `node --test test/*.test.js` hoàn toàn ngoại tuyến (363 kiểm thử) bằng cách tiêm (inject) các hàm giả lập `fetch`, `fs` và `execFile` (không bao giờ đọc `~/.claude/.credentials.json` hay `~/.codex/auth.json` thật, không gọi mạng và không chạy `agy` thật).

Các điểm CHƯA được kiểm chứng tại thời điểm soạn README này:

1. Lượt gọi mạng thật từ `ai-quota-bar` tới máy chủ Anthropic (`/api/oauth/usage`, bao gồm phản hồi mảng `limits` thật và bước dự phòng `curl` khi bị chặn TLS) và ChatGPT (`/backend-api/wham/usage`): header, bước dự phòng `curl` và bộ phân tích phản hồi của Claude và Codex được cài đặt dựa trên việc đọc mã tham chiếu và kiểm thử bằng dữ liệu mẫu (fixture) ngoại tuyến, chưa chạy thử với mạng thật.
2. Quan sát trực tiếp bằng mắt và trình đọc màn hình trong cửa sổ VS Code hoặc Antigravity IDE (cả tiếng Anh và tiếng Việt) khi cả ba mục thanh trạng thái cùng hiển thị cạnh nhau (kể cả menu chuột phải để ẩn/hiện riêng từng mục và NVDA/Narrator đọc `accessibilityInformation`), trang Settings (`order` và `scope: application`), tooltip, thông báo và danh sách QuickPick gộp.
3. Hành vi thực tế trên macOS và Linux (và macOS Keychain của Claude Code hiện chưa được hỗ trợ).
4. Nhiều tiến trình hệ điều hành độc lập tranh chấp khóa `state-<id>.lock` cùng lúc.
5. Hành vi khi đi qua HTTP proxy trên các phiên bản VS Code khác nhau (`1.90`-`1.93` so với các bản mới hơn) và khi dùng Remote SSH, WSL, Dev Container.

## 7. Giấy phép

MIT. Xem tệp `LICENSE`.
