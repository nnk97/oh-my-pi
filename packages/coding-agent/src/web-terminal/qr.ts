import qrcode from "qrcode-terminal";

export function renderQrCode(text: string): string {
	let output = "";
	qrcode.generate(text, { small: false }, code => {
		output = code
			.replace(/\r/g, "")
			.split("\n")
			.map(line => line.trimEnd())
			.filter(line => line.trim().length > 0)
			.join("\n");
	});
	return output;
}
