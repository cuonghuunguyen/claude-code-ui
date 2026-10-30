# Quyền & chế độ {#permissions-modes}

Trước khi Claude chạy một công cụ (một lệnh, một lần sửa tệp), Claude có thể hỏi bạn. Cách này hoạt động giống hệt Claude Code, với cùng quy tắc.

<img class="only-light" src="/screenshots/permissions.png" alt="Yêu cầu cấp quyền cho một lần sửa tệp, kèm diff và các nút Cho phép và Từ chối">
<img class="only-dark" src="/screenshots/permissions-dark.png" alt="Yêu cầu cấp quyền cho một lần sửa tệp, ở chế độ tối">

## Cách trả lời yêu cầu cấp quyền {#how-to-answer-a-permission-request}

Một thẻ hiện phía trên ô nhập prompt. Thẻ cho biết công cụ và việc nó muốn làm (lệnh, hoặc diff của lần sửa).

| Nút | Tác dụng |
| --- | --- |
| **Cho phép một lần** | Chạy lần này. |
| **Luôn cho phép** | Chạy và lưu một quy tắc để Claude không hỏi lại cho cùng việc đó. Thẻ hiển thị quy tắc trước. |
| **Từ chối** | Chặn lại. Nhập vào **Không, và cho Claude biết cần làm khác đi như thế nào** để nói lý do cho Claude. |

- Với lần sửa tệp, **Sửa nội dung** cho phép bạn đổi văn bản trước khi cho phép.
- Yêu cầu đang chờ bạn cũng được liệt kê trên [trang Focus](focus) và có thể gửi [thông báo](notifications).

## Câu hỏi {#questions}

Claude có thể đặt câu hỏi nhiều lựa chọn: chọn một phương án (hoặc tự nhập) rồi bấm **Gửi**; nhiều câu hỏi được chia trang bằng **Quay lại** và **Tiếp**. **Bỏ qua** sẽ bỏ qua câu hỏi và dừng lượt, giống <kbd>Esc</kbd> trong Claude Code.

## Chế độ quyền {#permission-modes}

Chế độ quyết định điều xảy ra trước khi một công cụ chạy. Đổi chế độ bằng bộ chọn dưới ô nhập prompt, hoặc nhấn <kbd>Shift</kbd>+<kbd>Tab</kbd> để chuyển vòng.

| Chế độ | Điều xảy ra |
| --- | --- |
| **Hỏi trước khi sửa** | Hỏi trước khi sửa và chạy lệnh (mặc định). |
| **Tự động sửa** | Sửa tệp mà không hỏi. Lệnh vẫn hỏi. |
| **Chế độ kế hoạch** | Claude chỉ đọc và lập kế hoạch. Claude hiển thị kế hoạch và hỏi trước khi bắt đầu. |
| **Chế độ tự động** | Một bộ phân loại quyết định việc nào an toàn để chạy. |
| **Không hỏi** | Từ chối mọi thứ chưa được quy tắc đã lưu cho phép. |
| **Bỏ qua quyền** | Chạy mọi thứ mà không hỏi. Bị ẩn trừ khi bạn khởi động với `--allow-bypass`. |

## Chế độ kế hoạch {#plan-mode}

Khi Claude lập xong kế hoạch, thẻ hiển thị kế hoạch với ba nút:

- **Có, tự duyệt từng lần sửa:** bắt đầu, và hỏi trước khi sửa.
- **Có, và tự chấp nhận lần sửa:** bắt đầu, và sửa mà không hỏi.
- **Không, tiếp tục lập kế hoạch:** ở lại chế độ kế hoạch. Nhập nội dung cần đổi.

## Cần biết {#good-to-know}

- Quy tắc bạn lưu bằng **Luôn cho phép** là quy tắc riêng của Claude Code. CLI `claude` cũng dùng chúng.
- Các model và chế độ được cung cấp phụ thuộc vào tài khoản Claude của bạn.
