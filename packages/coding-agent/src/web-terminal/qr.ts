import qrcode from "qrcode-terminal";

export function renderQrCode(text: string): string {
	let output = "";
	qrcode.generate(text, { small: true }, code => {
		output = code.trimEnd();
	});
	return output;
}
