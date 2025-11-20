import bcryptjs from "bcryptjs";

const run = async () => {
  const password = "hentepenger1243!"; // nytt passord til Karl
  const hash = await bcryptjs.hash(password, 10);
  console.log("Hash:", hash);
};

run();
